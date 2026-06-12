const { execFile: childExecFile } = require('node:child_process');

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
    throw new PortManagerError('INVALID_ARGUMENT', `${name} must be an integer between ${min} and ${max}`, {
      status: 400,
      details: { [name]: value },
    });
  }
  return number;
}

function parseLsofOutput(stdout) {
  const lines = String(stdout || '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);

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

    ports.push({
      port,
      pid,
      processName,
      user,
      type,
      protocol,
      address,
    });
  }

  return ports;
}

function defaultExecFile(file, args = [], options = {}) {
  return new Promise((resolve, reject) => {
    childExecFile(file, args, { timeout: 10_000, maxBuffer: 2 * 1024 * 1024, ...options }, (error, stdout, stderr) => {
      const exitCode = error && typeof error.code === 'number' ? error.code : 0;
      if (error && !options.allowNonZero) {
        error.stdout = stdout;
        error.stderr = stderr;
        reject(error);
        return;
      }
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

  async function listPorts() {
    if (options.listPorts) {
      const ports = await options.listPorts();
      return [...ports].sort((a, b) => a.port - b.port || a.pid - b.pid);
    }

    const { stdout } = await runner.execFile('lsof', ['-iTCP', '-sTCP:LISTEN', '-P', '-n'], { allowNonZero: true });
    const ports = parseLsofOutput(stdout);
    const uniquePids = [...new Set(ports.map((portInfo) => portInfo.pid))];
    const commandMap = await getProcessCommands(uniquePids);

    return ports
      .map((portInfo) => ({
        ...portInfo,
        commandLine: commandMap[portInfo.pid] || 'Unknown command',
      }))
      .sort((a, b) => a.port - b.port || a.pid - b.pid);
  }

  async function getProcessCommands(pids) {
    const entries = await Promise.all(
      pids.map(async (pid) => {
        try {
          const { stdout } = await runner.execFile('ps', ['-p', String(pid), '-o', 'command='], { allowNonZero: true });
          return [pid, stdout.trim() || 'Unknown command'];
        } catch (_err) {
          return [pid, 'Unknown command'];
        }
      })
    );
    return Object.fromEntries(entries);
  }

  async function findProcessByPort({ port, pid } = {}) {
    const normalizedPort = validateInteger('port', port, { min: 1, max: 65535 });
    const normalizedPid = pid === undefined ? undefined : validateInteger('pid', pid, { min: 1 });
    const matches = (await listPorts()).filter((portInfo) => {
      if (portInfo.port !== normalizedPort) return false;
      if (normalizedPid !== undefined && portInfo.pid !== normalizedPid) return false;
      return true;
    });

    if (matches.length === 0) {
      throw new PortManagerError('PORT_NOT_FOUND', `No listening process found on port ${normalizedPort}`, {
        status: 404,
        details: { port: normalizedPort, pid: normalizedPid },
      });
    }

    return matches[0];
  }

  async function killProcessOnPort({ port, pid, confirm = false, allowSystemPort = false, force = false, waitMs = 800 } = {}) {
    const normalizedPort = validateInteger('port', port, { min: 1, max: 65535 });
    const normalizedPid = validateInteger('pid', pid, { min: 1 });
    const portInfo = await findProcessByPort({ port: normalizedPort });

    // === Safety Layer Check (outer gate) ===
    if (safetyLayer) {
      const check = await safetyLayer.checkDestructive(
        { ...portInfo, port: normalizedPort, pid: normalizedPid },
        { allowSystemPort: allowSystemPort === true }
      );
      if (!check.ok) {
        throw new PortManagerError('SAFETY_' + check.check.toUpperCase(), check.reason, {
          status: 403,
          details: { ...check.details, safetyCheck: check.check },
        });
      }
    }

    if (portInfo.pid !== normalizedPid) {
      throw new PortManagerError('PORT_PID_MISMATCH', `Port ${normalizedPort} is held by PID ${portInfo.pid}, not PID ${normalizedPid}`, {
        status: 409,
        details: { requestedPid: normalizedPid, actualPid: portInfo.pid, port: normalizedPort },
      });
    }

    if (normalizedPid === selfPid || normalizedPort === selfPort) {
      throw new PortManagerError('REFUSE_SELF', 'Refusing to terminate the Port Manager process itself', {
        status: 403,
        details: { pid: normalizedPid, port: normalizedPort, selfPid, selfPort },
      });
    }

    if (normalizedPort <= 1024 && allowSystemPort !== true) {
      throw new PortManagerError('SYSTEM_PORT_REQUIRES_ALLOW', 'Refusing to terminate a system port unless allowSystemPort=true', {
        status: 403,
        details: { pid: normalizedPid, port: normalizedPort },
      });
    }

    if (confirm !== true) {
      return {
        dryRun: true,
        wouldSignal: 'SIGTERM',
        target: portInfo,
        message: 'Set confirm=true to send SIGTERM. Set force=true to follow up with SIGKILL if still alive.',
      };
    }

    killFn(normalizedPid, 'SIGTERM');
    const result = {
      dryRun: false,
      signalSent: 'SIGTERM',
      target: portInfo,
    };

    if (force === true) {
      await sleep(waitMs);
      try {
        killFn(normalizedPid, 0);
        killFn(normalizedPid, 'SIGKILL');
        result.escalatedSignal = 'SIGKILL';
      } catch (err) {
        if (err && err.code === 'ESRCH') {
          result.escalatedSignal = null;
        } else {
          throw err;
        }
      }
    }

    return result;
  }

  async function restartProcessOnPort() {
    throw new PortManagerError(
      'RESTART_NOT_IMPLEMENTED',
      'restart_process_on_port is intentionally disabled until an explicit command allowlist is implemented; arbitrary shell command restart is unsafe.',
      { status: 501 }
    );
  }

  return {
    listPorts,
    findProcessByPort,
    killProcessOnPort,
    restartProcessOnPort,
  };
}

module.exports = {
  PortManagerError,
  parseLsofOutput,
  createPortService,
};
