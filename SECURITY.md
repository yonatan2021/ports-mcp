# Security Policy

## Intended Use

`ports-mcp` is a local-only development tool for macOS. It exposes process and port information and can terminate processes. Do not expose it to a LAN or the public internet without a separate authentication and authorization layer.

The HTTP server now binds to `127.0.0.1:9999` by default. Keep that default unless you have a specific, reviewed reason to bind elsewhere.

## Sensitive Information

`list_ports` / `GET /api/ports` returns process command lines. Command-line arguments sometimes contain tokens, CSRF values, file paths, usernames, or other sensitive local context. Treat tool output as private operator data.

## Destructive Capabilities

### Process Termination (`kill_process_on_port`, `safe_kill_process`)

Safety rails:
- Validates that the requested `pid` still owns the requested `port` before signaling.
- Refuses to terminate the Port Manager's own PID/port.
- Refuses low/system ports (`<=1024`) unless `allowSystemPort=true` or allowed by safety mode.
- Dry-runs unless `confirm=true`.
- Uses `SIGTERM` first. `SIGKILL` fallback requires `force=true`.
- Uses `process.kill(pid, signal)` rather than interpolated shell commands.
- **Rate limited**: max 5 kills/minute, 3s cooldown between operations.
- **Process blocklist**: critical system processes (launchd, kernel_task, init, etc.) are hard-blocked.
- **Safety Mode**: "read-only" blocks all termination, "allowlist" limits to specific ports, "blocklist" blocks specific ports.

### Process Suspension (`suspend_process`, `resume_process`)

- Uses `SIGSTOP` to suspend and `SIGCONT` to resume.
- Refuses to suspend critical system processes (launchd, kernel_task, init, etc.) or the Port Manager itself.
- Dry-runs unless `confirm=true`.

### Cache Clean-up (`clean_cache`)

- Restricted to a predefined set of safe user and developer cache folders (NPM, Xcode, Cargo, Gradle, Bun, etc.).
- Moves files/directories to the macOS System Trash rather than immediate permanent deletion (`rm -rf`), allowing recovery.
- Detects active directory locks (`ACTIVE_PROCESS_LOCK`) before trying to delete.
- Dry-runs unless `confirm=true`.

### Restart (`restart_process_on_port`, `safe_restart_process`)

Restart is intentionally disabled to prevent arbitrary code execution (RCE) vectors.

## Command Execution Model

- Port listing uses `execFile('lsof', ['-iTCP', '-sTCP:LISTEN', '-P', '-n'])`.
- Command-line enrichment uses `execFile('ps', ['-p', pid, '-o', 'command='])`.
- Cache listing uses node `fs.stat` and `du -sk` inside safe paths.
- No untrusted user inputs are interpolated into shell strings.

## Permission Model

| Capability | Default | Notes |
|------------|---------|-------|
| List ports | Allowed locally | Reveals command lines and local services |
| Find process by port | Allowed locally | Same sensitivity as list |
| Verify process owner | Allowed locally | Owner verification tool |
| Get process details | Allowed locally | Reveals parent PID, uptime, command line |
| Kill process | Dry-run unless `confirm=true` | Guarded, rate-limited |
| Suspend process | Dry-run unless `confirm=true` | Pauses process (SIGSTOP), system processes blocked |
| Resume process | Allowed locally | Resumes process (SIGCONT) |
| List caches | Allowed locally | Scans safe cache paths and sizes |
| Clean cache | Dry-run unless `confirm=true` | Moves to system Trash |
| Restart process | Disabled | Always returns `RESTART_NOT_IMPLEMENTED` |

## Hardening Summary

| Protection | Where | Description |
|------------|-------|-------------|
| Safety Modes (Read-only, Guarded, Allow/Blocklist) | safety.js / settings.js | Dynamic configurations via UI/API to restrict actions |
| Rate limiting | port-service.js | max 5 kills/min, 3s cooldown |
| Process blocklist | port-service.js | Critical system processes hard-blocked |
| System port protection | port-service.js | Ports < 1024 blocked unless overridden |
| Self-kill protection | port-service.js | Cannot kill own PID/port |
| Trash integration | port-service.js | Moves cache folders to system Trash instead of raw deletion |
| Audit logging | port-service.js | Structured JSON to stderr |
| Path sanitizer | port-service.js | stripUserPaths() for error messages |
| Response caps | port-service.js / mcp-server.js | MAX_PORTS_RETURNED = 500 |
| Tool execution timeout | mcp-server.js | 15s per tool call |
| Safety warnings | mcp-server.js | In tool descriptions |
| Server timeout | http-server.js | 30s request timeout |
| Security headers | http-server.js | X-Content-Type-Options, X-Frame-Options, Cache-Control |
| Input validation | http-server.js | Port/PID type checking in Express routes |
| Host header validation | http-server.js | Prevents DNS-rebinding attacks |
| CI/CD pipeline | .github/workflows/security.yml | gitleaks, npm audit, CodeQL, test matrix |
| Attack surface audit | docs/attack-surface-audit.md | 12 vectors analyzed, documented |

## Recommended Hardening

1. Keep `HOST=127.0.0.1`.
2. Do not run as root.
3. Do not expose stdio MCP access to untrusted agents.
4. If restart is added later, require an explicit allowlist of command IDs, not raw command lines.

## Publish Checklist

Before making this repository public, verify:

- [ ] `.gitignore` covers `node_modules/`, `.env*`, `.DS_Store`, logs, coverage, and local artifacts.
- [ ] No `.env` files, tokens, API keys, certificates, or local caches are tracked.
- [ ] No machine-specific paths (`/Users/...`, `/home/...`) appear in source files or committed docs.
- [ ] `node_modules/` is untracked.
- [ ] README documents MCP usage and the local-only security model.
- [ ] Tests pass with `npm test`.
- [ ] Repository visibility is intentionally chosen (private until privacy/security review is complete).
