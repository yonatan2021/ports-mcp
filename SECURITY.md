# Security Policy

## Intended Use

`ports-mcp` is a local-only development tool for macOS. It exposes process and port information and can terminate processes. Do not expose it to a LAN or the public internet without a separate authentication and authorization layer.

The HTTP server now binds to `127.0.0.1:9999` by default. Keep that default unless you have a specific, reviewed reason to bind elsewhere.

## Sensitive Information

`list_ports` / `GET /api/ports` returns process command lines. Command-line arguments sometimes contain tokens, CSRF values, file paths, usernames, or other sensitive local context. Treat tool output as private operator data.

## Destructive Capabilities

### Kill (`kill_process_on_port`, `POST /api/ports/kill`)

Safety rails:

- Validates that the requested `pid` still owns the requested `port` before signaling.
- Refuses to terminate the Port Manager's own PID/port.
- Refuses low/system ports (`<=1024`) unless `allowSystemPort=true`.
- Dry-runs unless `confirm=true`.
- Uses `SIGTERM` first. `SIGKILL` fallback requires `force=true`.
- Uses `process.kill(pid, signal)` rather than interpolated shell commands.
- **Rate limited**: max 5 kills/minute, 3s cooldown between operations.
- **Process blocklist**: critical system processes (launchd, kernel_task, init, etc.) are hard-blocked.
- **Safety layer**: read-only mode blocks all destructive ops by default.

Risks that remain:

- `SIGTERM` can still interrupt important local work.
- The PID/port state can change after validation; the implementation narrows but cannot eliminate TOCTOU risk.
- The caller is responsible for checking the target details before confirming.

### Restart (`restart_process_on_port`, `POST /api/ports/restart`)

Restart is intentionally disabled.

The previous web app accepted a client-provided `commandLine` and ran it with `shell:true`, which is arbitrary code execution. That path has been removed. A future restart feature must use an explicit local allowlist of known safe commands; do not restore arbitrary command execution.

## Command Execution Model

- Port listing uses `execFile('lsof', ['-iTCP', '-sTCP:LISTEN', '-P', '-n'])`.
- Command-line enrichment uses `execFile('ps', ['-p', pid, '-o', 'command='])`.
- No untrusted PID/port values are interpolated into shell strings.

## Permission Model

| Capability | Default | Notes |
|------------|---------|-------|
| List ports | Allowed locally | Reveals command lines and local services |
| Find process by port | Allowed locally | Same sensitivity as list |
| Kill process | Dry-run unless `confirm=true` | Guarded, still destructive |
| Kill system port | Denied unless `allowSystemPort=true` | Requires explicit override |
| Kill system process | Blocked | launchd, kernel_task, init, etc. |
| Restart process | Disabled | Needs future allowlist design |

## Hardening Summary

| Protection | Where | Description |
|------------|-------|-------------|
| Rate limiting | port-service.js | max 5 kills/min, 3s cooldown |
| Process blocklist | port-service.js | Critical system processes hard-blocked |
| System port protection | port-service.js | Ports < 1024 blocked unless overridden |
| Self-kill protection | port-service.js | Cannot kill own PID/port |
| Audit logging | port-service.js | Structured JSON to stderr |
| Path sanitizer | port-service.js | stripUserPaths() for error messages |
| Response caps | port-service.js / mcp-server.js | MAX_PORTS_RETURNED = 500 |
| Tool execution timeout | mcp-server.js | 15s per tool call |
| Safety warnings | mcp-server.js | In tool descriptions |
| Server timeout | http-server.js | 30s request timeout |
| Security headers | http-server.js | X-Content-Type-Options, X-Frame-Options, Cache-Control |
| Input validation | http-server.js | Port/PID type checking in Express routes |
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
