const { execFile: childExecFile } = require('node:child_process');

const MAX_PORTS_RETURNED = 500;
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

  function checkProcessBlocklist(name) {
    const blocked = [...PROCESS_BLOCKLIST].find(b => name.toLowerCase() === b.toLowerCase());
    if (blocked) throw new PortManagerError('PROCESS_BLOCKED', `Process "${name}" is on the system blocklist and cannot be terminated.`, { status: 403, details: { processName: name } });
  }

  async function runSafetyCheck(target, { allowSystemPort = false } = {}) {
    if (!safetyLayer) return;
    const result = await safetyLayer.checkDestructive(target, { allowSystemPort });
    if (!result.ok) {
      throw new PortManagerError(`SAFETY_${result.check.toUpperCase()}`, result.reason, { status: 403, details: result.details || {} });
    }
  }

  async function listPorts() {
    if (options.listPorts) {
      const ports = await options.listPorts();
      let sorted = [...ports].sort((a, b) => a.port - b.port || a.pid - b.pid);
      if (sorted.length > MAX_PORTS_RETURNED) sorted.length = MAX_PORTS_RETURNED;
      return sorted;
    }
    const { stdout } = await runner.execFile('lsof', ['-iTCP', '-sTCP:LISTEN', '-P', '-n'], { allowNonZero: true });
    const ports = parseLsofOutput(stdout);
    const uniquePids = [...new Set(ports.map(p => p.pid))];
    const commandMap = await getProcessCommands(uniquePids);
    let results = ports.map(p => ({ ...p, commandLine: commandMap[p.pid] || 'Unknown command' })).sort((a, b) => a.port - b.port || a.pid - b.pid);
    if (results.length > MAX_PORTS_RETURNED) results.length = MAX_PORTS_RETURNED;
    return results;
  }

  async function getProcessCommands(pids) {
    const entries = await Promise.all(pids.map(async (pid) => {
      try { const { stdout } = await runner.execFile('ps', ['-p', String(pid), '-o', 'command='], { allowNonZero: true }); return [pid, stdout.trim() || 'Unknown command']; }
      catch { return [pid, 'Unknown command']; }
    }));
    return Object.fromEntries(entries);
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
    await runSafetyCheck(portInfo, { allowSystemPort });

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

  return { listPorts, findProcessByPort, killProcessOnPort, restartProcessOnPort };
}

module.exports = { PortManagerError, parseLsofOutput, createPortService, stripUserPaths, PROCESS_BLOCKLIST, MAX_PORTS_RETURNED, isSystemProcess };
