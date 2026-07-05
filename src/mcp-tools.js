/**
 * mcp-tools.js — Agent-optimized MCP tools for ports-mcp
 *
 * Wraps port-service + safety-layer with structured JSON output,
 * rich error responses with safe_hints, and detailed tool descriptions
 * designed for AI agent consumers.
 *
 * Every tool returns:
 *   Success: { ok: true, data: {...}, warnings: [...] }
 *   Error:   { error: true, code, message, safe_hint }
 */

const { PortManagerError } = require('./port-service');

// ---------------------------------------------------------------------------
// Structured response helpers
// ---------------------------------------------------------------------------

function success(data, warnings = []) {
  return { ok: true, data, warnings };
}

function agentError(code, message, safeHint, details = {}) {
  return { error: true, code, message, safe_hint: safeHint, details };
}

function wrapServiceError(err) {
  if (err instanceof PortManagerError) {
    return agentError(
      err.code,
      err.message,
      `A PortManagerError occurred. Check the code and details for context. Safe operations like list_ports or get_process_details may still work.`,
      err.details || {}
    );
  }
  return agentError(
    'INTERNAL_ERROR',
    err.message || 'Unexpected error',
    'An unexpected internal error occurred. Try a simpler operation or check server logs.',
    {}
  );
}

// ---------------------------------------------------------------------------
// Agent Tools Factory
// ---------------------------------------------------------------------------

/**
 * Create agent-optimized tools backed by a port service and safety layer.
 *
 * @param {object} deps
 * @param {import('./port-service').PortService} deps.service
 * @param {import('./safety').SafetyLayer|null} deps.safetyLayer
 * @param {object} deps.runner — { execFile } for shell commands
 */
function createAgentTools({ service, safetyLayer, runner = null } = {}) {
  if (!service) {
    const err = new Error('service is required');
    err.code = 'MISSING_DEPENDENCY';
    err.safe_hint = 'Cannot create agent tools without a port service.';
    throw err;
  }

  /**
   * verify_process_owner
   *
   * Given a port + pid, returns the owner username of the process.
   * WARNING: This is a read-only informational tool — no destructive action is performed.
   *
   * @param {number} port — TCP port number (1–65535). WARNING: Must match a currently listening port.
   * @param {number} pid  — Process ID. WARNING: Must match the actual PID holding the given port.
   * @returns {Promise<object>} Structured response with owner info.
   */
  async function verifyProcessOwner({ port, pid }) {
    try {
      const portInfo = await service.findProcessByPort({ port, pid });

      let owner = portInfo.user || null;

      // Double-check via ps for reliability
      if (runner && runner.execFile && portInfo.pid) {
        try {
          const { stdout } = await runner.execFile(
            'ps', ['-p', String(portInfo.pid), '-o', 'user='],
            { allowNonZero: true }
          );
          const psOwner = (stdout || '').trim();
          if (psOwner) owner = psOwner;
        } catch (_) {
          // fallback to lsof user field
        }
      }

      return success({
        port,
        pid: portInfo.pid,
        processName: portInfo.processName,
        owner,
        verifiedBy: runner && runner.execFile ? 'ps' : 'lsof',
      });
    } catch (err) {
      return wrapServiceError(err);
    }
  }

  /**
   * get_process_details
   *
   * Full process information for a given port (and optionally pid).
   * Returns: pid, port, processName, user, commandLine, uptime, ppid, address, protocol.
   * WARNING: Read-only informational tool — no destructive action is performed.
   *
   * @param {number} port — TCP port number (1–65535)
   * @param {number} [pid] — Optional PID to disambiguate if multiple processes listen on the same port
   * @returns {Promise<object>} Structured response with full process details.
   */
  async function getProcessDetails({ port, pid }) {
    try {
      const portInfo = await service.findProcessByPort({ port, pid });

      // Enrich with ps details (uptime, ppid, full command)
      let details = { ...portInfo };

      if (runner && runner.execFile && portInfo.pid) {
        try {
          // Request: pid, ppid, user, comm, etime (elapsed time), args
          const psFields = 'pid,ppid,user,comm,etime,args';
          const { stdout } = await runner.execFile(
            'ps', ['-p', String(portInfo.pid), '-o', psFields],
            { allowNonZero: true }
          );
          const lines = (stdout || '').trim().split('\n');
          if (lines.length >= 2) {
            const parts = lines[1].trim().split(/\s+/);
            // ps -o pid,ppid,user,comm,etime,args output:
            // [pid, ppid, user, comm, elapsed, args...]
            if (parts.length >= 6) {
              details.ppid = parseInt(parts[1], 10) || null;
              details.uptime = parts[4] || null;  // index 4 = ELAPSED (etime)
            }
          }
        } catch (_) {
          // ps enrichment is best-effort
        }
      }

      return success({
        port: details.port,
        pid: details.pid,
        processName: details.processName,
        user: details.user,
        commandLine: details.commandLine || 'Unknown',
        uptime: details.uptime || null,
        ppid: details.ppid || null,
        protocol: details.protocol || null,
        address: details.address || null,
        type: details.type || null,
      });
    } catch (err) {
      return wrapServiceError(err);
    }
  }

  /**
   * safe_kill_process
   *
   * WARNING: Destructive action. Terminates a process by sending SIGTERM (and optionally SIGKILL).
   *
   * Safety guards (ALL must pass):
   *   1. Permission mode — read-only mode blocks all kills
   *   2. Allowlist/Blocklist — port must be allowed (or not blocked) per current mode
   *   3. System port protection — ports < 1024 blocked unless in allowlist
   *   4. Process name blocklist — system processes (launchd, kernel_task, etc.) always blocked
   *   5. Owner verification — can only kill processes owned by the same user running the MCP
   *   6. Rate limiting — max N kills per minute with cooldown
   *
   * @param {number} port — TCP port number (1–65535). WARNING: Must match a currently listening port.
   * @param {number} pid  — Process ID to terminate. WARNING: Must match the actual PID holding the port.
   * @param {boolean} [confirm=false] — Set true to actually send SIGTERM. Without it, this is a dry run.
   * @param {boolean} [force=false]   — Set true to follow up with SIGKILL if process doesn't die after SIGTERM.
   * @returns {Promise<object>} Structured response with kill result.
   */
  async function safeKillProcess({ port, pid, confirm = false, force = false }) {
    try {
      const warnings = [];
      const result = await service.killProcessOnPort({ port, pid, confirm, force });

      if (result.dryRun) {
        warnings.push('Dry-run mode: set confirm=true to actually send SIGTERM.');
      }
      if (force === false) {
        warnings.push('Process may survive SIGTERM. Set force=true for SIGKILL escalation.');
      }

      return success({
        dryRun: result.dryRun || false,
        signalSent: result.signalSent || null,
        escalatedSignal: result.escalatedSignal ?? undefined,
        target: result.target
          ? {
              port: result.target.port,
              pid: result.target.pid,
              processName: result.target.processName,
              user: result.target.user,
            }
          : null,
      }, warnings);
    } catch (err) {
      return wrapServiceError(err);
    }
  }

  /**
   * safe_restart_process
   *
   * WARNING: Intentionally disabled. Restarting a process requires executing an arbitrary
   * shell command, which is unsafe without an explicit command allowlist.
   *
   * @param {number} port — TCP port number (1–65535)
   * @param {number} pid  — Process ID
   * @param {string} [commandLine] — Command to restart with (ignored)
   * @returns {Promise<object>} Structured error response.
   */
  async function safeRestartProcess({ port, pid, commandLine }) {
    try {
      await service.restartProcessOnPort({ port, pid, commandLine });
      // Should never reach here — restartProcessOnPort always throws
      return agentError(
        'RESTART_NOT_IMPLEMENTED',
        'safe_restart_process is intentionally disabled until an explicit command allowlist is implemented. Arbitrary shell command restart is unsafe.',
        'This tool requires a command allowlist feature that is not yet implemented. Consider restarting the process manually or using a process manager like launchd/systemd.',
        { port, pid }
      );
    } catch (err) {
      // Catch PortManagerError from restartProcessOnPort specifically
      // and return the agent-friendly version with a useful safe_hint
      if (err instanceof PortManagerError && err.code === 'RESTART_NOT_IMPLEMENTED') {
        return agentError(
          'RESTART_NOT_IMPLEMENTED',
          'safe_restart_process is intentionally disabled until an explicit command allowlist is implemented.',
          'This tool requires a command allowlist feature that is not yet implemented. Consider restarting the process manually or using a process manager like launchd/systemd.',
          { port, pid }
        );
      }
      return wrapServiceError(err);
    }
  }

  /**
   * get_safety_status
   *
   * Returns the current safety configuration and rate-limiter state.
   * Read-only informational tool — no destructive action is performed.
   *
   * @returns {Promise<object>} Structured response with safety status.
   */
  async function getSafetyStatus() {
    const warnings = [];

    const status = safetyLayer
      ? safetyLayer.getStatus()
      : { mode: 'none', note: 'No safety layer configured. All operations are permitted.' };

    if (status.mode === 'read-only') {
      warnings.push('Server is in read-only mode. No destructive operations (kill, restart) are allowed.');
    }
    if (status.mode === 'none') {
      warnings.push('No safety layer configured. System process protection is NOT active.');
    }
    if (status.rateLimit && status.rateLimit.activeOpsInWindow >= (status.rateLimit.maxPerMinute * 0.8)) {
      warnings.push(`Rate limit approaching: ${status.rateLimit.activeOpsInWindow}/${status.rateLimit.maxPerMinute} operations used this minute.`);
    }

    return success({
      mode: status.mode,
      verifyOwner: status.verifyOwner,
      currentUser: status.currentUser,
      selfPid: status.selfPid,
      selfPort: status.selfPort,
      allowlist: status.allowlist || [],
      blocklistCount: status.blocklist ? status.blocklist.length : 0,
      processBlocklistCount: status.processBlocklistCount || 0,
      rateLimit: status.rateLimit
        ? {
            maxPerMinute: status.rateLimit.maxPerMinute,
            activeOpsInWindow: status.rateLimit.activeOpsInWindow,
          }
        : null,
      cooldown: status.cooldown
        ? {
            cooldownMs: status.cooldown.cooldownMs,
            timeSinceLastOp: status.cooldown.timeSinceLastOp,
          }
        : null,
    }, warnings);
  }

  async function getSystemUsage() {
    try {
      const usage = await service.getSystemUsage();
      return success(usage);
    } catch (err) {
      return wrapServiceError(err);
    }
  }

  async function listSystemProcesses() {
    try {
      const processes = await service.getSystemProcesses();
      return success({ processes });
    } catch (err) {
      return wrapServiceError(err);
    }
  }

  async function suspendProcess({ pid }) {
    try {
      const result = await service.suspendProcess({ pid });
      return success(result);
    } catch (err) {
      return wrapServiceError(err);
    }
  }

  async function resumeProcess({ pid }) {
    try {
      const result = await service.resumeProcess({ pid });
      return success(result);
    } catch (err) {
      return wrapServiceError(err);
    }
  }

  return {
    verifyProcessOwner,
    getProcessDetails,
    safeKillProcess,
    safeRestartProcess,
    getSafetyStatus,
    getSystemUsage,
    listSystemProcesses,
    suspendProcess,
    resumeProcess,
  };
}

module.exports = { createAgentTools };
