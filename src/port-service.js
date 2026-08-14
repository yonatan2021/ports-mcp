const { execFile: childExecFile } = require('node:child_process');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs/promises');
const { identifyProject } = require('./project-intelligence');


const MAX_PORTS_RETURNED = 500;
const PROCESS_QUERY_BATCH_SIZE = 100;
const PROCESS_BLOCKLIST = new Set([
  'launchd', 'kernel_task', 'init', 'syslogd', 'notifyd', 'configd',
  'UserEventAgent', 'WindowServer', 'coreaudiod', 'audio', 'logd',
  'opendirectoryd', 'mds', 'mds_stores', 'bird', 'cfprefsd',
  'distnoted', 'com.apple.xpc', 'securityd', 'sandboxd',
  'systemd', 'systemd-journald', 'systemd-logind', 'systemd-udevd',
  'sshd', 'cron', 'rsyslogd', 'dbus-daemon', 'polkitd',
  'agetty', 'login', 'init.d',
]);
const RATE_LIMIT = { maxKillsPerMinute: 5, cooldownMs: 3000 };
const USER_DIR_PATTERN = /\/Users\/[^/]+/g;

function stripUserPaths(text) {
  if (typeof text !== 'string') return text;
  return text.replace(USER_DIR_PATTERN, '/Users/<redacted>');
}

function isSystemProcess(portObj) {
  if (!portObj) return false;
  const user = portObj.user;
  if (user && (user === 'root' || user.startsWith('_'))) {
    return true;
  }

  const cmd = portObj.commandLine || '';
  if (
    cmd.startsWith('/System/') ||
    cmd.startsWith('/usr/libexec/') ||
    cmd.startsWith('/usr/sbin/')
  ) {
    return true;
  }

  const name = (portObj.processName || '').toLowerCase();
  const isCritical = PROCESS_BLOCKLIST.has(name) ||
                     name === 'controlcenter' ||
                     name === 'control center' ||
                     name === 'windowserver';
  if (isCritical) {
    return true;
  }

  return false;
}

const PROCESS_HUMAN_INFO = {
  'node': { title: 'Node.js', description: 'סביבת הרצת JavaScript / שרת פיתוח מקומי', category: 'CAUTION' },
  'python': { title: 'Python', description: 'תסריט או שרת פיתוח ב-Python', category: 'CAUTION' },
  'python3': { title: 'Python 3', description: 'תסריט או שרת פיתוח ב-Python', category: 'CAUTION' },
  'chrome': { title: 'Google Chrome', description: 'דפדפן אינטרנט Google Chrome', category: 'SAFE' },
  'google chrome': { title: 'Google Chrome', description: 'דפדפן אינטרנט Google Chrome', category: 'SAFE' },
  'safari': { title: 'Safari', description: 'דפדפן אינטרנט Safari של Apple', category: 'SAFE' },
  'firefox': { title: 'Firefox', description: 'דפדפן אינטרנט Mozilla Firefox', category: 'SAFE' },
  'code': { title: 'VS Code', description: 'עורך קוד Visual Studio Code', category: 'SAFE' },
  'electron': { title: 'Electron App', description: 'אפליקציית שולחן עבודה המבוססת על Electron', category: 'SAFE' },
  'docker': { title: 'Docker', description: 'מנוע קונטיינרים פיתוחי', category: 'CAUTION' },
  'dockerd': { title: 'Docker Daemon', description: 'שירות הרקע של Docker', category: 'CAUTION' },
  'git': { title: 'Git', description: 'מערכת ניהול גרסאות קוד', category: 'SAFE' },
  'windowserver': { title: 'WindowServer', description: 'מנוע התצוגה והחלונות של macOS (קריטי למערכת)', category: 'SYSTEM_PROTECTED' },
  'kernel_task': { title: 'kernel task', description: 'ליבת מערכת ההפעלה macOS (ניהול חום ומעבד)', category: 'SYSTEM_PROTECTED' },
  'launchd': { title: 'launchd', description: 'מנהל התהליכים הראשי של macOS', category: 'SYSTEM_PROTECTED' },
  'finder': { title: 'Finder', description: 'מנהל הקבצים והשולחן עבודה של macOS', category: 'CAUTION' },
  'dock': { title: 'Dock', description: 'סרגל האפליקציות של macOS', category: 'CAUTION' },
  'spotlight': { title: 'Spotlight', description: 'מנגנון החיפוש של macOS', category: 'SAFE' },
  'slack': { title: 'Slack', description: 'אפליקציית תקשורת צוותים', category: 'SAFE' },
  'discord': { title: 'Discord', description: 'אפליקציית צ\'אט ותקשורת', category: 'SAFE' },
  'telegram': { title: 'Telegram', description: 'אפליקציית הודעות מיידיות', category: 'SAFE' },
  'postgres': { title: 'PostgreSQL', description: 'מסד נתונים יחסים', category: 'CAUTION' },
  'mysqld': { title: 'MySQL', description: 'מסד נתונים MySQL', category: 'CAUTION' },
  'mongod': { title: 'MongoDB', description: 'מסד נתונים מסמכים', category: 'CAUTION' },
  'redis-server': { title: 'Redis', description: 'מסד נתונים בזיכרון (Cache)', category: 'CAUTION' },
  'ollama': { title: 'Ollama AI', description: 'שרת מודלי שפה (LLM) מקומי', category: 'CAUTION' },
};

function enrichProcessHumanInfo(procObj) {
  const key = (procObj.processName || '').toLowerCase();
  const info = PROCESS_HUMAN_INFO[key];
  if (procObj.isSystem) {
    return {
      humanTitle: info ? info.title : procObj.processName,
      humanDescription: info ? info.description : 'תהליך מערכת מוגן של macOS',
      safetyCategory: 'SYSTEM_PROTECTED'
    };
  }
  if (info) {
    return {
      humanTitle: info.title,
      humanDescription: info.description,
      safetyCategory: info.category
    };
  }
  return {
    humanTitle: procObj.processName,
    humanDescription: 'אפליקציית משתמש או תהליך מקומי',
    safetyCategory: 'SAFE'
  };
}


function createRateLimiter({ maxPerMinute = RATE_LIMIT.maxKillsPerMinute, cooldownMs = RATE_LIMIT.cooldownMs } = {}) {
  const timestamps = [];
  function check() {
    const now = Date.now();
    while (timestamps.length > 0 && timestamps[0] < now - 60_000) timestamps.shift();
    if (timestamps.length >= maxPerMinute) {
      const oldest = timestamps[0];
      const waitMs = 60_000 - (now - oldest);
      throw new PortManagerError('RATE_LIMITED', `Kill rate limit exceeded. Max ${maxPerMinute} kills/min. Retry in ${Math.ceil(waitMs / 1000)}s.`, { status: 429, details: { maxPerMinute, retryAfterMs: waitMs } });
    }
    if (timestamps.length > 0) {
      const elapsed = Date.now() - timestamps[timestamps.length - 1];
      if (elapsed < cooldownMs) {
        throw new PortManagerError('COOLDOWN_ACTIVE', `Wait ${Math.ceil((cooldownMs - elapsed) / 1000)}s between kills.`, { status: 429, details: { cooldownMs } });
      }
    }
    timestamps.push(now);
  }
  return { check };
}

function auditLog(entry) {
  const sanitized = {};
  for (const [key, value] of Object.entries(entry)) {
    sanitized[key] = typeof value === 'string' ? stripUserPaths(value) : value;
  }
  console.error('[ports-mcp-audit]', JSON.stringify({ ...sanitized, _timestamp: new Date().toISOString() }));
}

class PortManagerError extends Error {
  constructor(code, message, { status = 400, details = {} } = {}) {
    super(message);
    this.name = 'PortManagerError';
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

function validateInteger(name, value, { min = 1, max = Number.MAX_SAFE_INTEGER } = {}) {
  const number = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
  if (!Number.isInteger(number) || number < min || number > max) {
    throw new PortManagerError('INVALID_ARGUMENT', `${name} must be an integer between ${min} and ${max}`, { status: 400, details: { [name]: value } });
  }
  return number;
}

function parseLsofOutput(stdout) {
  const lines = String(stdout || '').split('\n').map(l => l.trim()).filter(Boolean);
  if (lines.length <= 1) return [];
  const ports = [];
  for (const line of lines.slice(1)) {
    const parts = line.split(/\s+/);
    const listenIndex = parts.lastIndexOf('(LISTEN)');
    if (listenIndex === -1 || listenIndex < 8) continue;
    const address = parts[listenIndex - 1];
    const protocol = parts[listenIndex - 2];
    const type = parts[listenIndex - 5];
    const user = parts[listenIndex - 7];
    const pid = Number(parts[listenIndex - 8]);
    const processName = parts.slice(0, listenIndex - 8).join(' ');
    const portMatch = address.match(/:(\d+)$/);
    const port = portMatch ? Number(portMatch[1]) : NaN;
    if (!Number.isInteger(pid) || !Number.isInteger(port)) continue;
    ports.push({ port, pid, processName, user, type, protocol, address });
  }
  return ports;
}

function defaultExecFile(file, args = [], options = {}) {
  return new Promise((resolve, reject) => {
    childExecFile(file, args, { timeout: 10_000, maxBuffer: 2 * 1024 * 1024, ...options }, (error, stdout, stderr) => {
      const exitCode = error && typeof error.code === 'number' ? error.code : 0;
      if (error && !options.allowNonZero) { error.stdout = stdout; error.stderr = stderr; reject(error); return; }
      resolve({ stdout, stderr, exitCode });
    });
  });
}

const defaultRunner = { execFile: defaultExecFile };

function createPortService(options = {}) {
  const runner = options.runner || defaultRunner;
  const selfPid = options.selfPid ?? process.pid;
  const selfPort = options.selfPort ?? validateInteger('selfPort', process.env.PORT || 9999, { min: 1, max: 65535 });
  const killFn = options.killFn || ((pid, signal) => process.kill(pid, signal));
  const sleep = options.sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const safetyLayer = options.safetyLayer || null;
  const rateLimiter = createRateLimiter();
  const homeDir = options.homeDir || os.homedir();
  const cwd = options.cwd || process.cwd();

  const sizeCache = {
    data: new Map(),
    get(dirPath) {
      const entry = this.data.get(path.normalize(dirPath));
      if (entry && Date.now() - entry.timestamp < 30_000) {
        return entry.bytes;
      }
      return null;
    },
    set(dirPath, bytes) {
      this.data.set(path.normalize(dirPath), { bytes, timestamp: Date.now() });
    },
    delete(dirPath) {
      this.data.delete(path.normalize(dirPath));
    },
    clear() {
      this.data.clear();
    }
  };

  const portsCache = {
    data: null,
    timestamp: 0,
    ttl: options.portsCacheTtl ?? 4000,
    get() {
      if (this.data && Date.now() - this.timestamp < this.ttl) {
        return this.data;
      }
      return null;
    },
    set(ports) {
      this.data = ports;
      this.timestamp = Date.now();
    },
    clear() {
      this.data = null;
      this.timestamp = 0;
    }
  };
  let portScanStatus = { state: 'unknown', observedAt: null, source: null, warning: null };

  const diskCache = {
    data: null,
    timestamp: 0,
    ttl: options.diskCacheTtl ?? 30_000,
    get() {
      if (this.data && Date.now() - this.timestamp < this.ttl) {
        return this.data;
      }
      return null;
    },
    set(data) {
      this.data = data;
      this.timestamp = Date.now();
    },
    clear() {
      this.data = null;
      this.timestamp = 0;
    }
  };

  const systemUsageCache = {
    data: null,
    timestamp: 0,
    ttl: options.systemUsageCacheTtl ?? 3500,
    get() {
      if (this.data && Date.now() - this.timestamp < this.ttl) {
        return this.data;
      }
      return null;
    },
    set(data) {
      this.data = data;
      this.timestamp = Date.now();
    },
    clear() {
      this.data = null;
      this.timestamp = 0;
    }
  };
  let portsInFlight = null;
  let systemUsageInFlight = null;
  let diskUsageInFlight = null;

  async function getSizesForPaths(paths) {
    const normPaths = paths.map(p => path.normalize(p));
    const missingPaths = [];
    const results = {};

    for (const p of normPaths) {
      const cached = sizeCache.get(p);
      if (cached !== null) {
        results[p] = cached;
      } else {
        missingPaths.push(p);
      }
    }

    if (missingPaths.length > 0) {
      try {
        const { stdout } = await runner.execFile('du', ['-sk', ...missingPaths], { allowNonZero: true });
        const sizeMap = new Map();
        String(stdout || '').split('\n').forEach(line => {
          const match = line.match(/^(\d+)\s+(.+)$/);
          if (match) {
            sizeMap.set(path.normalize(match[2]), Number(match[1]) * 1024);
          }
        });

        for (const p of missingPaths) {
          const bytes = sizeMap.get(p) || 0;
          sizeCache.set(p, bytes);
          results[p] = bytes;
        }
      } catch (err) {
        for (const p of missingPaths) {
          sizeCache.set(p, 0);
          results[p] = 0;
        }
        throw err;
      }
    }

    return results;
  }

  function checkProcessBlocklist(name) {
    const blocked = [...PROCESS_BLOCKLIST].find(b => name.toLowerCase() === b.toLowerCase());
    if (blocked) throw new PortManagerError('PROCESS_BLOCKED', `Process "${name}" is on the system blocklist and cannot be terminated.`, { status: 403, details: { processName: name } });
  }

  async function runSafetyCheck(target, { allowSystemPort = false, confirm = false } = {}) {
    if (!safetyLayer) return;
    const result = await safetyLayer.checkDestructive(target, { allowSystemPort, confirm });
    if (!result.ok) {
      throw new PortManagerError(`SAFETY_${result.check.toUpperCase()}`, result.reason, { status: 403, details: result.details || {} });
    }
  }

  async function scanPorts() {
    let ports;
    let primaryScanSucceeded = true;
    if (options.listPorts) {
      ports = await options.listPorts();
    } else {
      try {
        const { stdout } = await runner.execFile('lsof', ['-iTCP', '-sTCP:LISTEN', '-P', '-n'], { allowNonZero: true });
        const rawPorts = parseLsofOutput(stdout);
        const uniquePids = [...new Set(rawPorts.map(p => p.pid))];
        const [commandMap, workingDirectoryMap] = await Promise.all([
          getProcessCommands(uniquePids),
          getProcessWorkingDirectories(uniquePids),
        ]);
        ports = rawPorts.map(p => ({
          ...p,
          commandLine: commandMap[p.pid] || 'Unknown command',
          workingDirectory: workingDirectoryMap[p.pid] || null,
        }));
      } catch (error) {
        console.warn('[ports-mcp] Port scan degraded:', error && error.message ? error.message : 'lsof failed');
        portScanStatus = {
          state: 'degraded',
          observedAt: new Date().toISOString(),
          source: 'lsof',
          warning: 'לא ניתן להשלים את סריקת הפורטים. התוצאה עשויה להיות חלקית.',
        };
        ports = [];
        primaryScanSucceeded = false;
      }
    }

    let metricsMap = new Map();
    const portPids = [...new Set(ports.map(port => port.pid).filter(Number.isInteger))];
    try {
      const systemProcesses = portPids.length > 0 ? await getSystemProcesses({ pids: portPids }) : [];
      for (const proc of systemProcesses) {
        metricsMap.set(proc.pid, { cpu: proc.cpu, memoryMb: proc.memoryMb });
      }
    } catch (err) {
      // Ignore metrics fetch errors to keep listPorts robust
    }

    let results = ports.map(p => {
      const enriched = { ...p, commandLine: p.commandLine || 'Unknown command' };
      const metrics = metricsMap.get(p.pid) || { cpu: 0, memoryMb: 0 };
      return {
        ...enriched,
        cpu: metrics.cpu,
        memoryMb: metrics.memoryMb,
        isSystem: p.isSystem !== undefined ? p.isSystem : isSystemProcess(enriched),
        project: identifyProject(enriched),
      };
    }).sort((a, b) => a.port - b.port || a.pid - b.pid);

    if (results.length > MAX_PORTS_RETURNED) results.length = MAX_PORTS_RETURNED;
    // A new successful scan supersedes an earlier degraded snapshot. Keeping the
    // old state would make recovery look permanently broken to both API clients.
    if (primaryScanSucceeded) {
      portScanStatus = { state: 'ready', observedAt: new Date().toISOString(), source: 'lsof', warning: null };
    }
    portsCache.set(results);
    return results;
  }

  async function listPorts({ bypassCache = false } = {}) {
    if (bypassCache) {
      portsCache.clear();
    }
    const cached = portsCache.get();
    if (cached !== null) {
      return cached;
    }
    if (portsInFlight !== null) {
      return portsInFlight;
    }

    portsInFlight = scanPorts();
    try {
      return await portsInFlight;
    } finally {
      portsInFlight = null;
    }
  }

  function getPortScanStatus() {
    return { ...portScanStatus };
  }

  async function getProcessCommands(pids) {
    if (pids.length === 0) return {};
    const result = Object.fromEntries(pids.map(pid => [pid, 'Unknown command']));
    const batches = [];
    for (let index = 0; index < pids.length; index += PROCESS_QUERY_BATCH_SIZE) {
      batches.push(pids.slice(index, index + PROCESS_QUERY_BATCH_SIZE));
    }

    await Promise.all(batches.map(async batch => {
      try {
        const { stdout } = await runner.execFile(
          'ps',
          ['-p', batch.join(','), '-o', 'pid=,command='],
          { allowNonZero: true }
        );
        for (const line of String(stdout || '').split('\n')) {
          const match = line.trim().match(/^(\d+)\s+(.+)$/);
          if (match) result[Number(match[1])] = match[2];
        }
      } catch {
        const entries = await Promise.all(batch.map(async pid => {
          try {
            const { stdout } = await runner.execFile('ps', ['-p', String(pid), '-o', 'command='], { allowNonZero: true });
            return [pid, String(stdout || '').trim() || 'Unknown command'];
          } catch {
            return [pid, 'Unknown command'];
          }
        }));
        for (const [pid, command] of entries) result[pid] = command;
      }
    }));

    return result;
  }

  async function getProcessWorkingDirectories(pids) {
    if (pids.length === 0) return {};
    try {
      const pidList = pids.join(',');
      const { stdout } = await runner.execFile('lsof', ['-a', '-p', pidList, '-d', 'cwd', '-Fn'], { allowNonZero: true });
      const lines = String(stdout || '').split('\n').map(l => l.trim()).filter(Boolean);
      const workingDirectoryMap = {};
      let currentPid = null;
      for (const line of lines) {
        if (line.startsWith('p')) {
          currentPid = Number(line.slice(1));
        } else if (line.startsWith('n/') && currentPid !== null) {
          workingDirectoryMap[currentPid] = line.slice(1);
        }
      }
      const result = {};
      for (const pid of pids) {
        result[pid] = workingDirectoryMap[pid] || null;
      }
      return result;
    } catch (err) {
      const entries = await Promise.all(pids.map(async (pid) => {
        try {
          const { stdout } = await runner.execFile('lsof', ['-a', '-p', String(pid), '-d', 'cwd', '-Fn'], { allowNonZero: true });
          const workingDirectory = String(stdout || '').split('\n').find(line => line.startsWith('n/'))?.slice(1);
          return [pid, workingDirectory || null];
        } catch {
          return [pid, null];
        }
      }));
      return Object.fromEntries(entries);
    }
  }

  async function findProcessByPort({ port, pid } = {}) {
    const normalizedPort = validateInteger('port', port, { min: 1, max: 65535 });
    const normalizedPid = pid === undefined ? undefined : validateInteger('pid', pid, { min: 1 });
    const matches = (await listPorts()).filter(pi => {
      if (pi.port !== normalizedPort) return false;
      if (normalizedPid !== undefined && pi.pid !== normalizedPid) return false;
      return true;
    });
    if (matches.length === 0) throw new PortManagerError('PORT_NOT_FOUND', `No listening process found on port ${normalizedPort}`, { status: 404, details: { port: normalizedPort, pid: normalizedPid } });
    return matches[0];
  }

  async function killProcessOnPort({ port, pid, confirm = false, allowSystemPort = false, force = false, waitMs = 800 } = {}) {
    const normalizedPort = validateInteger('port', port, { min: 1, max: 65535 });
    const normalizedPid = validateInteger('pid', pid, { min: 1 });
    const portInfo = await findProcessByPort({ port: normalizedPort });
    if (portInfo.pid !== normalizedPid) throw new PortManagerError('PORT_PID_MISMATCH', `Port ${normalizedPort} is held by PID ${portInfo.pid}, not PID ${normalizedPid}`, { status: 409, details: { requestedPid: normalizedPid, actualPid: portInfo.pid, port: normalizedPort } });

    // Safety layer check (runs before all other checks for composability)
    await runSafetyCheck(portInfo, { allowSystemPort, confirm });

    // Self check
    if (normalizedPid === selfPid || normalizedPort === selfPort) throw new PortManagerError('REFUSE_SELF', 'Refusing to terminate Port Manager itself', { status: 403, details: { pid: normalizedPid, port: normalizedPort, selfPid, selfPort } });

    // System port check (only if safety layer didn't handle it)
    if (!safetyLayer && normalizedPort <= 1024 && allowSystemPort !== true) {
      throw new PortManagerError('SYSTEM_PORT_REQUIRES_ALLOW', 'Refusing system port unless allowSystemPort=true', { status: 403, details: { pid: normalizedPid, port: normalizedPort } });
    }

    // Process blocklist check (only if safety layer didn't handle it)
    if (!safetyLayer) {
      checkProcessBlocklist(portInfo.processName);
    }

    if (confirm !== true) return { dryRun: true, wouldSignal: 'SIGTERM', target: portInfo, message: 'Set confirm=true to send SIGTERM. Set force=true for SIGKILL fallback.' };

    // Rate limit (only if safety layer didn't handle it)
    if (!safetyLayer) {
      rateLimiter.check();
    }

    killFn(normalizedPid, 'SIGTERM');
    portsCache.clear();
    const result = { dryRun: false, signalSent: 'SIGTERM', target: portInfo };
    auditLog({ action: 'kill', signal: 'SIGTERM', pid: normalizedPid, port: normalizedPort, processName: portInfo.processName, user: portInfo.user });
    if (force === true) {
      await sleep(waitMs);
      try {
        killFn(normalizedPid, 0);
        killFn(normalizedPid, 'SIGKILL');
        result.escalatedSignal = 'SIGKILL';
        auditLog({ action: 'kill-escalate', signal: 'SIGKILL', pid: normalizedPid, port: normalizedPort, processName: portInfo.processName });
      } catch (err) {
        if (err && err.code === 'ESRCH') result.escalatedSignal = null;
        else throw err;
      }
    }
    return result;
  }

  async function restartProcessOnPort() {
    throw new PortManagerError('RESTART_NOT_IMPLEMENTED', 'restart_process_on_port is intentionally disabled; arbitrary shell restart is unsafe.', { status: 501 });
  }

  async function sampleSystemUsage() {
    const totalBytes = os.totalmem();
    let usedBytes = totalBytes - os.freemem();
    let memoryPercentage = parseFloat(((usedBytes / totalBytes) * 100).toFixed(1));

    try {
      const { stdout } = await runner.execFile('memory_pressure', ['-Q'], { allowNonZero: true });
      const freePercentageMatch = stdout.match(/System-wide memory free percentage:\s*(\d+(?:\.\d+)?)%/i);
      if (freePercentageMatch) {
        const freePercentage = Number(freePercentageMatch[1]);
        if (freePercentage >= 0 && freePercentage <= 100) {
          memoryPercentage = parseFloat((100 - freePercentage).toFixed(1));
          usedBytes = Math.round(totalBytes * (memoryPercentage / 100));
        }
      }
    } catch {
      // Non-macOS fallback: report process-visible free memory.
    }

    // Dynamic CPU calculation by sampling os.cpus()
    const cpus1 = os.cpus();
    await sleep(150);
    const cpus2 = os.cpus();

    let idleDiff = 0;
    let totalDiff = 0;
    for (let i = 0; i < cpus1.length; i++) {
      const t1 = cpus1[i].times;
      const t2 = cpus2[i].times;
      const idle = t2.idle - t1.idle;
      const user = t2.user - t1.user;
      const sys = t2.sys - t1.sys;
      const irq = t2.irq - t1.irq;
      const nice = t2.nice - t1.nice;
      idleDiff += idle;
      totalDiff += idle + user + sys + irq + nice;
    }
    const cpuPercentage = totalDiff === 0 ? 0 : parseFloat(((1 - idleDiff / totalDiff) * 100).toFixed(1));

    const result = {
      cpu: cpuPercentage,
      memory: {
        usedBytes,
        totalBytes,
        percentage: memoryPercentage
      }
    };
    systemUsageCache.set(result);
    return result;
  }

  async function getSystemUsage() {
    const cached = systemUsageCache.get();
    if (cached !== null) {
      return cached;
    }
    if (systemUsageInFlight !== null) {
      return systemUsageInFlight;
    }

    systemUsageInFlight = sampleSystemUsage();
    try {
      return await systemUsageInFlight;
    } finally {
      systemUsageInFlight = null;
    }
  }

  async function readDiskUsage() {
    const { stdout: diskStdout } = await runner.execFile('df', ['-kP', '/'], { allowNonZero: true });
    const diskLine = String(diskStdout || '').trim().split('\n').at(-1).trim().split(/\s+/);
    const totalKiB = Number(diskLine[1]);
    const usedKiB = Number(diskLine[2]);
    const availableKiB = Number(diskLine[3]);
    const percentage = Number.parseInt(diskLine[4], 10);

    if (![totalKiB, usedKiB, availableKiB, percentage].every(Number.isFinite)) {
      throw new PortManagerError('STORAGE_UNAVAILABLE', 'Could not read disk usage', { status: 503 });
    }

    const result = {
      totalBytes: totalKiB * 1024,
      usedBytes: usedKiB * 1024,
      availableBytes: availableKiB * 1024,
      percentage,
    };
    diskCache.set(result);
    return result;
  }

  async function getDiskUsage() {
    const cached = diskCache.get();
    if (cached !== null) {
      return cached;
    }
    if (diskUsageInFlight !== null) {
      return diskUsageInFlight;
    }

    diskUsageInFlight = readDiskUsage();
    try {
      return await diskUsageInFlight;
    } finally {
      diskUsageInFlight = null;
    }
  }

  async function getStorageUsage() {
    const disk = await getDiskUsage();

    const cacheDir = options.cacheDir || path.join(homeDir, 'Library', 'Caches');
    let cachePaths = [];
    try {
      const entries = await fs.readdir(cacheDir, { withFileTypes: true });
      cachePaths = entries
        .filter(entry => entry.isDirectory())
        .map(entry => path.join(cacheDir, entry.name))
        .sort()
        .slice(0, 200);
    } catch {
      // Cache access can be restricted by macOS privacy protections.
    }

    let cacheItems = [];
    if (cachePaths.length > 0) {
      try {
        const sizeMap = await getSizesForPaths(cachePaths);
        cacheItems = cachePaths.map(p => {
          const normPath = path.normalize(p);
          return { name: path.basename(p), path: p, bytes: sizeMap[normPath] || 0 };
        }).filter(item => Number.isFinite(item.bytes)).sort((a, b) => b.bytes - a.bytes).slice(0, 6);
      } catch {
        // Keep disk data useful even when individual cache folders are unavailable.
      }
    }

    return {
      disk: {
        ...disk,
      },
      cache: {
        knownBytes: cacheItems.reduce((total, item) => total + item.bytes, 0),
        scannedItems: cacheItems.length,
        items: cacheItems,
      },
    };
  }

  async function getSystemProcesses({ pid, pids } = {}) {
    const requestedPids = pid !== undefined
      ? [pid]
      : Array.isArray(pids)
        ? [...new Set(pids.filter(Number.isInteger))]
        : null;
    const args = ['-A', '-o', 'pcpu,rss,state,pid,user,comm'];
    if (requestedPids !== null) {
      args[0] = '-p';
      args.splice(1, 0, requestedPids.join(','));
    }
    const { stdout } = await runner.execFile('ps', args, { allowNonZero: true });
    const lines = stdout.trim().split('\n').slice(1);
    const processes = [];

    for (const line of lines) {
      const parts = line.trim().split(/\s+/);
      if (parts.length < 6) continue;
      const cpu = parseFloat(parts[0]);
      const rss = parseInt(parts[1], 10);
      const state = parts[2];
      const pidVal = parseInt(parts[3], 10);
      const user = parts[4];
      const commandLine = parts.slice(5).join(' ');

      if (Number.isNaN(pidVal) || Number.isNaN(cpu) || Number.isNaN(rss)) continue;

      const friendlyCmd = commandLine.replace(/\.app\/Contents\/MacOS\/.+$/, '').replace(/\.app$/, '');
      const processName = friendlyCmd.split('/').pop() || 'Unknown';
      const isSuspended = state.includes('T');

      const procObj = {
        pid: pidVal,
        processName,
        cpu,
        memoryMb: parseFloat((rss / 1024).toFixed(1)),
        user,
        isSuspended,
        commandLine,
      };

      procObj.isSystem = isSystemProcess(procObj);
      procObj.energyImpact = parseFloat((cpu * 1.2 + (procObj.memoryMb > 500 ? 5 : 1)).toFixed(1));
      const humanInfo = enrichProcessHumanInfo(procObj);
      procObj.humanTitle = humanInfo.humanTitle;
      procObj.humanDescription = humanInfo.humanDescription;
      procObj.safetyCategory = humanInfo.safetyCategory;
      processes.push(procObj);
    }

    if (requestedPids !== null) {
      return processes;
    }

    // Sort by CPU desc, limit to 50
    return processes.sort((a, b) => b.cpu - a.cpu || b.memoryMb - a.memoryMb).slice(0, 50);
  }

  async function suspendProcess({ pid, confirm = false }) {
    const normalizedPid = validateInteger('pid', pid, { min: 1 });
    const processes = await getSystemProcesses({ pid: normalizedPid });
    const target = processes.find(p => p.pid === normalizedPid);
    if (!target) throw new PortManagerError('PROCESS_NOT_FOUND', `Process PID ${normalizedPid} not found`, { status: 404 });

    await runSafetyCheck(target, { confirm });

    if (!safetyLayer) {
      checkProcessBlocklist(target.processName);
    }

    if (normalizedPid === selfPid) {
      throw new PortManagerError('REFUSE_SELF', 'Refusing to suspend Port Manager itself', { status: 403 });
    }

    if (confirm !== true) {
      return { dryRun: true, wouldSignal: 'SIGSTOP', target };
    }

    killFn(normalizedPid, 'SIGSTOP');
    portsCache.clear();
    auditLog({ action: 'suspend', pid: normalizedPid, processName: target.processName, user: target.user });
    return { ok: true, pid: normalizedPid, processName: target.processName };
  }

  async function resumeProcess({ pid }) {
    const normalizedPid = validateInteger('pid', pid, { min: 1 });
    const processes = await getSystemProcesses({ pid: normalizedPid });
    const target = processes.find(p => p.pid === normalizedPid);
    if (!target) throw new PortManagerError('PROCESS_NOT_FOUND', `Process PID ${normalizedPid} not found`, { status: 404 });

    await runSafetyCheck(target, { confirm: false });

    if (!safetyLayer) {
      checkProcessBlocklist(target.processName);
    }

    killFn(normalizedPid, 'SIGCONT');
    portsCache.clear();
    auditLog({ action: 'resume', pid: normalizedPid, processName: target.processName, user: target.user });
    return { ok: true, pid: normalizedPid, processName: target.processName };
  }

  async function killProcess({ pid, confirm = false }) {
    const normalizedPid = validateInteger('pid', pid, { min: 1 });
    const processes = await getSystemProcesses({ pid: normalizedPid });
    const target = processes.find(p => p.pid === normalizedPid);
    if (!target) throw new PortManagerError('PROCESS_NOT_FOUND', `Process PID ${normalizedPid} not found`, { status: 404 });

    await runSafetyCheck(target, { confirm });

    if (!safetyLayer) {
      checkProcessBlocklist(target.processName);
    }

    if (normalizedPid === selfPid) {
      throw new PortManagerError('REFUSE_SELF', 'Refusing to terminate Port Manager itself', { status: 403 });
    }

    if (confirm !== true) {
      return { dryRun: true, wouldSignal: 'SIGTERM', target };
    }

    killFn(normalizedPid, 'SIGTERM');
    portsCache.clear();
    auditLog({ action: 'kill-system-process', pid: normalizedPid, processName: target.processName, user: target.user });
    return { dryRun: false, signalSent: 'SIGTERM', target };
  }

  async function getCacheDetails() {
    const cacheDir = options.cacheDir || path.join(homeDir, 'Library', 'Caches');
    const globalCaches = [
      { name: 'npm Cache', path: path.join(homeDir, '.npm', '_cacache'), description: 'npm package manager download cache', category: 'SAFE_TO_CLEAR' },
      { name: 'Yarn Cache', path: path.join(cacheDir, 'Yarn'), description: 'Yarn package manager download cache', category: 'SAFE_TO_CLEAR' },
      { name: 'pnpm Cache', path: path.join(cacheDir, 'pnpm'), description: 'pnpm package manager download cache', category: 'SAFE_TO_CLEAR' },
      { name: 'Bun Cache', path: path.join(homeDir, '.bun', 'install', 'cache'), description: 'Bun package installation cache', category: 'SAFE_TO_CLEAR' },
      { name: 'Next.js Cache (.next/cache)', path: path.join(cwd, '.next', 'cache'), description: 'Local Next.js project build cache', category: 'SAFE_TO_CLEAR' },
      { name: 'Vite Cache', path: path.join(cwd, 'node_modules', '.cache'), description: 'Local Vite dependency pre-bundle cache', category: 'SAFE_TO_CLEAR' },
      { name: 'Gradle Cache', path: path.join(homeDir, '.gradle', 'caches'), description: 'Gradle dependency and build cache', category: 'SAFE_TO_CLEAR' },
      { name: 'Cargo Registry Cache', path: path.join(homeDir, '.cargo', 'registry'), description: 'Cargo package manager download registry cache', category: 'SAFE_TO_CLEAR' },
      { name: 'Cargo Git Cache', path: path.join(homeDir, '.cargo', 'git'), description: 'Cargo package manager Git dependency cache', category: 'SAFE_TO_CLEAR' },
      { name: 'CocoaPods Cache', path: path.join(cacheDir, 'CocoaPods'), description: 'CocoaPods dependency download cache', category: 'SAFE_TO_CLEAR' }
    ];

    let items = [];

    // Check global/local specific paths
    for (const item of globalCaches) {
      try {
        const stats = await fs.stat(item.path);
        if (stats.isDirectory()) {
          items.push(item);
        }
      } catch {}
    }

    // Scan general User Caches. Apple caches are reported separately as
    // protected, information-only entries.
    try {
      const entries = await fs.readdir(cacheDir, { withFileTypes: true });
      const systemCaches = entries
        .filter(entry => entry.isDirectory() && !['Yarn', 'pnpm', 'CocoaPods'].includes(entry.name) && !entry.name.startsWith('com.apple.'))
        .map(entry => ({
          name: entry.name,
          path: path.join(cacheDir, entry.name),
          description: `macOS User cache folder for ${entry.name}`,
          category: 'NEEDS_CONFIRMATION'
        }))
        .slice(0, 100);
      items.push(...systemCaches);
    } catch {}

    const protectedRoots = [
      {
        path: cacheDir,
        protectedGroup: 'apple-user',
        include: name => name.startsWith('com.apple.'),
        description: 'Apple cache in the user account (information only)'
      },
      {
        path: options.sharedCacheDir || '/Library/Caches',
        protectedGroup: 'shared-system',
        include: () => true,
        description: 'Managed by macOS and unavailable for cleaning'
      },
      {
        path: options.systemCacheDir || '/System/Library/Caches',
        protectedGroup: 'macos-system',
        include: () => true,
        description: 'Managed by macOS and unavailable for cleaning'
      }
    ];

    for (const root of protectedRoots) {
      try {
        const entries = await fs.readdir(root.path, { withFileTypes: true });
        items.push(...entries
          .filter(entry => entry.isDirectory() && root.include(entry.name))
          .map(entry => ({
            name: entry.name,
            path: path.join(root.path, entry.name),
            description: root.description,
            category: 'SYSTEM_PROTECTED',
            protectedGroup: root.protectedGroup
          }))
          .slice(0, 100));
      } catch {}
    }

    // Only cleanable user caches go through the destructive-path allowlist.
    // Protected entries are read-only information and may be outside $HOME.
    if (safetyLayer && typeof safetyLayer.checkCachePath === 'function') {
      const checkedItems = [];
      for (const item of items) {
        if (item.category === 'SYSTEM_PROTECTED') {
          checkedItems.push(item);
          continue;
        }
        try {
          await safetyLayer.checkCachePath(item.path);
          checkedItems.push(item);
        } catch {
          // If it throws any error, exclude it from returned items.
        }
      }
      items = checkedItems;
    }

    // Calculate sizes
    if (items.length > 0) {
      const paths = items.map(i => i.path);
      try {
        const sizeMap = await getSizesForPaths(paths);

        items = items.map(item => {
          const normPath = path.normalize(item.path);
          return {
            ...item,
            bytes: sizeMap[normPath] || 0
          };
        }).filter(item => item.bytes > 0);
      } catch {
        items = items.map(item => ({
          ...item,
          bytes: 0
        }));
      }
    }

    return items;
  }

  async function trashCachePath({ path: targetPath, paths, confirm = false }) {
    let targetPaths = [];
    if (targetPath) {
      targetPaths.push(targetPath);
    }
    if (paths && Array.isArray(paths)) {
      targetPaths.push(...paths);
    }
    targetPaths = [...new Set(targetPaths)];

    if (targetPaths.length === 0) {
      throw new PortManagerError('INVALID_ARGUMENT', 'No cache paths provided', { status: 400 });
    }

    const activePorts = await listPorts();
    for (const p of targetPaths) {
      const activeProcess = activePorts.find(proc => proc.commandLine && proc.commandLine.includes(p));
      if (activeProcess) {
        throw new PortManagerError('ACTIVE_PROCESS_LOCK', `Cannot delete cache path "${p}" because it is currently in use by active process ${activeProcess.pid}.`, { status: 409 });
      }
    }

    if (safetyLayer) {
      for (const p of targetPaths) {
        try {
          await safetyLayer.checkCachePath(p);
        } catch (err) {
          if (err.name === 'SafetyError') {
            throw new PortManagerError(err.code || 'SAFETY_ERROR', err.message, { status: 403, details: err.details || {} });
          }
          throw err;
        }
      }

      if (typeof safetyLayer.checkDestructive === 'function') {
        const result = await safetyLayer.checkDestructive(
          { user: safetyLayer.currentUser },
          { confirm }
        );
        if (!result.ok) {
          throw new PortManagerError(`SAFETY_${result.check.toUpperCase()}`, result.reason, { status: 403, details: result.details || {} });
        }
      }
    }

    if (confirm !== true) {
      if (!paths && targetPath) {
        return { dryRun: true, wouldTrash: targetPath };
      }
      return { dryRun: true, wouldTrash: targetPaths };
    }

    for (const p of targetPaths) {
      sizeCache.delete(p);
      let trashed = false;
      try {
        const { shell } = require('electron');
        if (shell && typeof shell.trashItem === 'function') {
          await shell.trashItem(p);
          trashed = true;
        }
      } catch {}

      if (!trashed) {
        const escapedPath = p.replace(/(["\\])/g, '\\$1');
        const appleScript = `tell application "Finder" to delete POSIX file "${escapedPath}"`;
        await runner.execFile('osascript', ['-e', appleScript]);
      }
    }

    if (!paths && targetPath) {
      return { ok: true, trashed: true, path: targetPath };
    }
    return { ok: true, trashed: true, paths: targetPaths };
  }

  async function getActivityMonitorSummary() {
    const [usage, diskStorage, allProcesses, listeningPorts] = await Promise.all([
      getSystemUsage(),
      getStorageUsage(),
      getSystemProcesses(),
      listPorts({ bypassCache: false })
    ]);

    const activePortsCount = listeningPorts.length;
    const cpuProcesses = [...allProcesses].sort((a, b) => b.cpu - a.cpu).slice(0, 25);
    const memoryProcesses = [...allProcesses].sort((a, b) => b.memoryMb - a.memoryMb).slice(0, 25);
    const energyProcesses = [...allProcesses].sort((a, b) => (b.energyImpact || 0) - (a.energyImpact || 0)).slice(0, 25);
    const diskProcesses = [...allProcesses].sort((a, b) => b.memoryMb - a.memoryMb).slice(0, 25);

    const portPidMap = new Map();
    for (const p of listeningPorts) {
      if (!portPidMap.has(p.pid)) {
        portPidMap.set(p.pid, []);
      }
      portPidMap.get(p.pid).push(p.port);
    }

    const networkProcesses = allProcesses.filter(p => portPidMap.has(p.pid)).map(p => ({
      ...p,
      ports: portPidMap.get(p.pid)
    })).concat(
      allProcesses.filter(p => !portPidMap.has(p.pid)).slice(0, 15)
    );

    const memoryPressure = usage.memory.percentage > 85 ? 'HIGH' : usage.memory.percentage > 60 ? 'MEDIUM' : 'NORMAL';

    return {
      timestamp: new Date().toISOString(),
      cpu: {
        usagePercentage: usage.cpu,
        activeProcessesCount: allProcesses.length,
        topProcesses: cpuProcesses
      },
      memory: {
        usedBytes: usage.memory.usedBytes,
        totalBytes: usage.memory.totalBytes,
        percentage: usage.memory.percentage,
        pressure: memoryPressure,
        topProcesses: memoryProcesses
      },
      energy: {
        totalImpact: parseFloat(energyProcesses.reduce((acc, p) => acc + (p.energyImpact || 0), 0).toFixed(1)),
        highImpactCount: energyProcesses.filter(p => (p.energyImpact || 0) > 10).length,
        preventingSleepCount: allProcesses.filter(p => p.isSuspended === false && p.cpu > 5).length,
        topProcesses: energyProcesses
      },
      disk: {
        totalBytes: diskStorage.disk.totalBytes,
        usedBytes: diskStorage.disk.usedBytes,
        availableBytes: diskStorage.disk.availableBytes,
        percentage: diskStorage.disk.percentage,
        cacheKnownBytes: diskStorage.cache.knownBytes,
        cacheItemsCount: diskStorage.cache.scannedItems,
        topProcesses: diskProcesses
      },
      network: {
        activePortsCount,
        listeningPorts,
        topProcesses: networkProcesses
      }
    };
  }

  return {
    listPorts,
    getPortScanStatus,
    findProcessByPort,
    killProcessOnPort,
    restartProcessOnPort,
    getSystemUsage,
    getDiskUsage,
    getStorageUsage,
    getSystemProcesses,
    suspendProcess,
    resumeProcess,
    killProcess,
    getCacheDetails,
    trashCachePath,
    getActivityMonitorSummary
  };
}

module.exports = { PortManagerError, parseLsofOutput, createPortService, stripUserPaths, PROCESS_BLOCKLIST, MAX_PORTS_RETURNED, isSystemProcess };
