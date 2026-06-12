# Agent Attack Surface Audit — ports-mcp

**Date:** 2026-06-12
**Scope:** ports-mcp MCP server + HTTP UI from the perspective of a potentially adversarial AI agent.
**Version analyzed:** feat/security-hardening branch

---

## Summary

| Severity | Count | Key Vectors |
|----------|-------|-------------|
| **HIGH** | 2 | Agent could abuse `kill` to disrupt services (rate-limited now), leak process info |
| **MEDIUM** | 3 | Data exfiltration via command lines, user enumeration, port scanning |
| **LOW** | 2 | Self-info leakage (PID, port), timing side-channels |
| **PROTECTED** | 3 | RCE via restart (disabled), system process kill (blocklisted), self-DoS (protected) |
| **LOW (info only)** | 2 | Memory exhaustion, stdout flooding |

---

## Attack Vectors

### HIGH

#### HV-1: Destructive kill abuse
**Vector:** Agent repeatedly calls `kill_process_on_port` with `confirm=true` to terminate arbitrary user processes.

**Mitigations:**
- Rate limiter: max 5 kills/min, 3s cooldown
- Process blocklist: critical system processes (launchd, kernel_task, etc.) are hard-blocked
- Self-kill protection: cannot kill own PID/port
- System port protection: ports < 1024 require explicit `allowSystemPort=true`
- Audit log: every kill is logged as structured JSON to stderr
- Safety layer: in read-only mode (default), all destructive ops are blocked

**Residual risk:** Agent can still kill user services (dev servers, databases). Acceptable for a dev tool.

#### HV-2: Information disclosure via process list
**Vector:** Agent uses `list_ports` to enumerate all listening services, their PIDs, users, and command-line arguments. Command-line args may contain tokens, passwords, or file paths.

**Mitigations:**
- Tool description warns about sensitive data in output
- No authentication required (local-only by design)
- Response capped at 500 ports to limit enumeration scope
- stripUserPaths() sanitizer for error messages

**Residual risk:** Agent sees command lines of all listening processes. Mitigation: bind to 127.0.0.1 only.

### MEDIUM

#### MV-1: Data exfiltration via command line leak
**Vector:** Agent calls `list_ports` repeatedly to capture command-line arguments that change over time.

**Mitigation:** Tool output is JSON and machine-parseable. Local-only binding prevents remote exfiltration. Rate limiter applies only to kills, not list_ports.

#### MV-2: User enumeration
**Vector:** Agent uses `list_ports` to discover which user accounts have running services.

**Mitigation:** Logging is stripped of user paths. Output is local-only. No authentication layer needed for a dev tool.

#### MV-3: Port scanning from within
**Vector:** Agent calls `find_process_by_port` on a range of ports to map the internal network.

**Mitigation:** Tool only works with active LISTEN ports (via lsof). Non-listening ports return 404. No port range scanning endpoint exists.

### LOW

#### LV-1: PID/self-info leakage
**Vector:** Agent can discover its own PID and port by examining error messages or timing.

**Mitigation:** PIDs are already visible via `list_ports`. Acceptable for a local dev tool.

#### LV-2: Timing side-channel on process existence
**Vector:** Agent can use response timing to determine if a process exists on a specific PID (difference between PORT_NOT_FOUND and valid response).

**Mitigation:** No practical risk for a local tool. Not mitigated.

### PROTECTED

#### PV-1: RCE via restart (Closed)
**Vector:** Previous `restart` accepted arbitrary command lines with `shell:true`. This was an RCE vector.

**Status:** **FIXED.** `restart_process_on_port` is now intentionally disabled. It always throws `RESTART_NOT_IMPLEMENTED`.

#### PV-2: System process kill (Closed)
**Vector:** Agent could kill `launchd`, `kernel_task`, or other critical system processes to crash the machine.

**Status:** **FIXED.** Process name blocklist prevents killing critical processes. System ports (<1024) are protected.

#### PV-3: Self-DoS by killing own infrastructure (Closed)
**Vector:** Agent could kill the Port Manager's own process.

**Status:** **FIXED.** Self-kill check prevents killing the process that runs the MCP server.

### LOW (informational)

#### IV-1: Memory exhaustion
**Vector:** Agent sends many rapid requests to exhaust server memory.

**Mitigation:** JSON body limit (16kb), no unbounded response accumulation. HTTP timeout (30s).

#### IV-2: stdout flooding
**Vector:** Agent causes verbose error logging that fills disk.

**Mitigation:** Audit log is structured JSON to stderr. No unbounded log accumulation.

---

## Hardening implemented

| Protection | Where | Status |
|-----------|-------|--------|
| Rate limiting (5 kills/min) | port-service.js | Done |
| 3s cooldown between kills | port-service.js | Done |
| Process name blocklist | port-service.js | Done |
| System port protection (<1024) | port-service.js | Done |
| Self-kill protection | port-service.js | Done |
| Audit logging (structured JSON) | port-service.js | Done |
| stripUserPaths() sanitizer | port-service.js | Done |
| MAX_PORTS_RETURNED (500) | port-service.js | Done |
| Tool execution timeout (15s) | mcp-server.js | Done |
| Safety warnings in tool descriptions | mcp-server.js | Done |
| Response caps with _meta.count | mcp-server.js | Done |
| Server timeout (30s) | http-server.js | Done |
| Headers timeout (35s) | http-server.js | Done |
| Security headers (XCTO, XFO, Cache-Control) | http-server.js | Done |
| Input validation on Express routes | http-server.js | Done |
| CI/CD: gitleaks, npm audit, CodeQL | .github/workflows/security.yml | Done |

## What remains

- No authentication layer (local-only dev tool — acceptable)
- No remote access protection (127.0.0.1 binding — acceptable)
- No encryption (not applicable for local-only stdio/HTTP)
