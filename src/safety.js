/**
 * safety.js — Safety permission layer + system process protection for ports-mcp
 *
 * Wraps destructive operations with layered safety checks:
 *   1. Permission mode       (read-only / allowlist / blocklist)
 *   2. Owner verification     (can only kill processes owned by the same user)
 *   3. Process name blocklist (hardcoded critical system processes)
 *   4. System port protection (ports < 1024 blocked unless explicitly allowed)
 *   5. Rate limiting          (max ops/minute + cooldown)
 *   6. Self-kill protection   (integrated from port-service via config self-ref)
 */

const os = require('node:os');
const path = require('node:path');

/**
 * Error class for safety violations.
 * Separate from PortManagerError so MCP consumers can distinguish
 * "you can't do that because it's unsafe" from "the operation failed".
 */
class SafetyError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'SafetyError';
    this.code = code;
    this.details = details;
  }
}

/**
 * Sliding-window rate limiter.
 * Tracks timestamps of recent operations and rejects if over limit.
 */
class SlidingWindowRateLimiter {
  constructor({ maxPerWindow, windowMs } = {}) {
    this.maxPerWindow = maxPerWindow;
    this.windowMs = windowMs;
    this.timestamps = [];
  }

  /**
   * Check if an operation is allowed.
   * Returns { allowed: boolean, remaining: number, resetMs: number }
   */
  check() {
    const now = Date.now();
    const windowStart = now - this.windowMs;

    // Prune expired entries
    this.timestamps = this.timestamps.filter((t) => t > windowStart);

    const remaining = this.maxPerWindow - this.timestamps.length;

    if (remaining <= 0) {
      // Next reset is the oldest timestamp + window
      const oldest = this.timestamps[0];
      const resetMs = oldest ? (oldest + this.windowMs - now) : this.windowMs;
      return { allowed: false, remaining: 0, resetMs: Math.max(resetMs, 0) };
    }

    return { allowed: true, remaining, resetMs: 0 };
  }

  /** Record that an operation was performed. */
  record() {
    this.timestamps.push(Date.now());
  }

  /** Reset the rate limiter (for testing or config change). */
  reset() {
    this.timestamps = [];
  }
}

/**
 * Simple cooldown tracker.
 * Ensures a minimum delay between consecutive operations.
 */
class CooldownTracker {
  constructor({ minIntervalMs } = {}) {
    this.minIntervalMs = minIntervalMs;
    this.lastOpAt = 0;
  }

  check() {
    const elapsed = Date.now() - this.lastOpAt;
    if (elapsed < this.minIntervalMs) {
      return {
        allowed: false,
        waitMs: this.minIntervalMs - elapsed,
      };
    }
    return { allowed: true, waitMs: 0 };
  }

  record() {
    this.lastOpAt = Date.now();
  }
}

class SafetyLayer {
  /**
   * @param {object} options
   * @param {import('./config').SafetyConfig} options.config
   * @param {object} options.runner         — { execFile } for shell commands (owner check)
   * @param {string} [options.currentUser]  — override current user (default: os.userInfo().username)
   * @param {number} [options.selfPid]      — override self pid (default: process.pid)
   * @param {number} [options.selfPort]     — override self port (default: process.env.PORT || 9999)
   */
  constructor(options = {}) {
    this.config = options.config;
    this.runner = options.runner;
    this.currentUser = options.currentUser || os.userInfo().username;
    this.selfPid = options.selfPid ?? process.pid;
    this.selfPort = options.selfPort ?? Number(process.env.PORT || 9999);

    // Rate limiters — reset when config changes
    this._rateLimiter = null;
    this._cooldown = null;
    this._initRateLimiters();
  }

  _initRateLimiters() {
    this._rateLimiter = new SlidingWindowRateLimiter({
      maxPerWindow: this.config.maxOpsPerMinute,
      windowMs: 60_000,
    });
    this._cooldown = new CooldownTracker({
      minIntervalMs: this.config.cooldownMs,
    });
  }

  /** Re-read rate limit settings from config (call after config change). */
  refreshRateLimiters() {
    this._initRateLimiters();
  }

  /**
   * Run all safety checks for a destructive operation on a given port target.
   *
   * @param {object} target — port info object from listPorts()
   *   Expected fields: { port, pid, processName, user, ... }
   * @param {object} [options]
   * @param {boolean} [options.allowSystemPort] — override system port protection
   * @param {boolean} [options.confirm] — commit the operation to rate limiters
   * @returns {Promise<{ ok: boolean, check: string, reason?: string, details?: object }>}
   */
  async checkDestructive(target, { allowSystemPort = false, confirm = false } = {}) {
    // === 1. Permission Mode ===
    if (this.config.mode === 'read-only') {
      return {
        ok: false,
        check: 'mode',
        reason: `Server is in read-only mode. No destructive operations allowed.`,
        details: { mode: 'read-only' },
      };
    }

    // === 2. Allowlist / Blocklist ===
    if (target.port != null) {
      if (this.config.mode === 'allowlist') {
        if (!this.config.allowlist.has(target.port)) {
          return {
            ok: false,
            check: 'allowlist',
            reason: `Port ${target.port} is not in the allowlist. Add it first (set_allowlist) or switch modes.`,
            details: { port: target.port, mode: 'allowlist' },
          };
        }
      }

      if (this.config.mode === 'blocklist') {
        if (this.config.blocklist.has(target.port)) {
          return {
            ok: false,
            check: 'blocklist',
            reason: `Port ${target.port} is in the blocklist. Remove it first or switch modes.`,
            details: { port: target.port, mode: 'blocklist' },
          };
        }
      }
    }

    // === 3. System port protection (ports < 1024) ===
    if (target.port != null && target.port < 1024 && allowSystemPort !== true) {
      // Check if it's explicitly in the allowlist (override)
      if (!this.config.allowlist.has(target.port)) {
        return {
          ok: false,
          check: 'system_port',
          reason: `Port ${target.port} is a system port (< 1024). Set allowSystemPort=true or add to allowlist.`,
          details: { port: target.port, minPrivilegedPort: 1024 },
        };
      }
    }

    // === 3b. Dynamic System Process protection ===
    if (target.isSystem === true) {
      return {
        ok: false,
        check: 'system_process',
        reason: `Process "${target.processName}" is identified as a macOS system process and cannot be terminated.`,
        details: { processName: target.processName, pid: target.pid }
      };
    }

    // === 4. Process name blocklist ===
    const blockedProcess = this.config.processBlocklist.find(
      (name) => target.processName && target.processName.toLowerCase().includes(name.toLowerCase())
    );


    if (blockedProcess) {
      return {
        ok: false,
        check: 'process_name_blocklist',
        reason: `Process "${target.processName}" matches blocked name "${blockedProcess}". Cannot terminate critical system processes.`,
        details: { processName: target.processName, matchedRule: blockedProcess },
      };
    }

    // === 5. Owner verification ===
    if (this.config.verifyOwner) {
      // The port info already has a 'user' field from lsof output
      if (target.user && target.user !== this.currentUser) {
        const portContext = target.port !== undefined ? ` on port ${target.port}` : '';
        return {
          ok: false,
          check: 'owner',
          reason: `Process${portContext} is owned by "${target.user}", not by current user "${this.currentUser}". Can only terminate your own processes.`,
          details: { processOwner: target.user, currentUser: this.currentUser },
        };
      }

      // Double-check via ps as fallback (more reliable than lsof user field)
      if (target.pid != null) {
        try {
          const owner = await this._getProcessOwner(target.pid);
          if (owner && owner !== this.currentUser) {
            return {
              ok: false,
              check: 'owner_verified',
              reason: `Process PID ${target.pid} is owned by "${owner}" (confirmed via ps), not by "${this.currentUser}". Blocked.`,
              details: { pid: target.pid, verifiedOwner: owner, currentUser: this.currentUser },
            };
          }
        } catch (_err) {
          // If we can't verify, log but don't block — lsof user field is sufficient
          console.warn(`[safety] Could not verify owner of PID ${target.pid}: ${_err.message}`);
        }
      }
    }

    // === 6. Rate limiting ===
    const rateCheck = this._rateLimiter.check();
    if (!rateCheck.allowed) {
      return {
        ok: false,
        check: 'rate_limit',
        reason: `Rate limit exceeded. Max ${this.config.maxOpsPerMinute} operations per minute. Try again in ${Math.ceil(rateCheck.resetMs / 1000)}s.`,
        details: {
          maxPerMinute: this.config.maxOpsPerMinute,
          resetMs: rateCheck.resetMs,
        },
      };
    }

    const cooldownCheck = this._cooldown.check();
    if (!cooldownCheck.allowed) {
      return {
        ok: false,
        check: 'cooldown',
        reason: `Cooldown active. Wait ${Math.ceil(cooldownCheck.waitMs / 1000)}s between operations.`,
        details: { cooldownMs: this.config.cooldownMs, waitMs: cooldownCheck.waitMs },
      };
    }

    // All checks passed — record rate limit usage ONLY if confirmed
    if (confirm === true) {
      this._rateLimiter.record();
      this._cooldown.record();
    }

    return { ok: true, check: 'all_passed' };
  }

  /**
   * Get the owner (username) of a process by PID using `ps`.
   */
  async _getProcessOwner(pid) {
    if (!this.runner || !this.runner.execFile) {
      return null;
    }

    const { stdout } = await this.runner.execFile('ps', ['-p', String(pid), '-o', 'user='], { allowNonZero: true });
    return (stdout || '').trim() || null;
  }

  /**
   * Get a snapshot of current safety state for MCP tools.
   */
  getStatus() {
    return {
      mode: this.config.mode,
      verifyOwner: this.config.verifyOwner,
      currentUser: this.currentUser,
      selfPid: this.selfPid,
      selfPort: this.selfPort,
      rateLimit: {
        maxPerMinute: this.config.maxOpsPerMinute,
        activeOpsInWindow: this._rateLimiter.timestamps.length,
      },
      cooldown: {
        cooldownMs: this.config.cooldownMs,
        timeSinceLastOp: Date.now() - this._cooldown.lastOpAt,
      },
      ...this.config.toJSON(),
    };
  }

  checkCachePath(targetPath) {
    if (typeof targetPath !== 'string') {
      throw new SafetyError('INVALID_PATH', 'Path must be a string.');
    }

    if (targetPath.includes('..')) {
      throw new SafetyError('PATH_TRAVERSAL', `Path traversal detected in "${targetPath}".`);
    }

    const normalized = path.normalize(targetPath);
    const homeDir = os.homedir();

    if (normalized !== homeDir && !normalized.startsWith(homeDir + path.sep)) {
      throw new SafetyError('PATH_OUTSIDE_HOME', `Path "${normalized}" is outside the user home directory.`);
    }

    const allowedPatterns = [
      /\/\.npm$/,
      /\/Library\/Caches\/.+/,
      /\/\.bun\/install\/cache$/,
      /\/\.next\/cache$/,
      /\/node_modules\/\.cache$/,
      /\/\.vite$/
    ];

    const isMatch = allowedPatterns.some(pattern => pattern.test(normalized));
    if (!isMatch) {
      throw new SafetyError('PATH_NOT_A_CACHE', `Path "${normalized}" is not a recognized or safe cache folder.`);
    }

    return true;
  }
}

module.exports = {
  SafetyLayer,
  SafetyError,
  SlidingWindowRateLimiter,
  CooldownTracker,
};
