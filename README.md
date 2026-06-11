# ports-mcp — macOS Port Manager

> ⚠️ **DANGER: This tool can terminate running processes.**  
> Killing a process can cause data loss, crash running applications, or destabilise your system.  
> **Always confirm the PID and port before taking action.** This tool is safe by design (dry-run by default, guarded by explicit confirmation), but *you* are responsible for what you kill.

macOS **only** — uses `lsof` and `ps`, which are macOS-specific.

Local-only MCP server and optional web UI for inspecting macOS listening TCP ports.

The priority entrypoint is the stdio MCP server for AI agents. The existing browser UI remains available for local manual use.

> Security posture: safe by default. Listing ports is read-only. Killing a process is guarded and dry-runs unless `confirm=true`. Restart is intentionally disabled until there is an explicit allowlist; the old arbitrary `shell:true` restart path was removed.

## Who this is for

- Developers who need to inspect which processes own a local TCP port.
- AI agent frameworks that need to programmatically manage port conflicts.
- **Not** for production servers, multi-user environments, or remote access.

## Features

- `list_ports` MCP tool: lists listening TCP ports via `lsof`, enriched with `ps` command lines.
- `find_process_by_port` MCP tool: returns one listening process for a TCP port.
- `kill_process_on_port` MCP tool: **destructive but guarded:**
  - validates `pid` still owns `port` immediately before signaling
  - refuses to kill the Port Manager itself
  - refuses system ports (`<=1024`) unless `allowSystemPort=true`
  - dry-runs unless `confirm=true`
  - sends `SIGTERM` first; optional `force=true` can follow with `SIGKILL`
- `restart_process_on_port` MCP tool: present but disabled with a structured `RESTART_NOT_IMPLEMENTED` error.
- Express web UI/API for local browser use.
- Mockable command-runner/test harness for parser and destructive guards.

## Requirements

- **macOS** (uses `lsof` and `ps`)
- Node.js 18+

## Install

```bash
npm install
```

## Run the MCP server

```bash
npm run mcp
```

For Hermes or another MCP client, configure a stdio server command similar to:

```yaml
mcp_servers:
  ports-mcp:
    command: node
    args:
      - /absolute/path/to/ports/src/mcp-server.js
```

## Run the web UI

```bash
npm start
```

Default address: `http://127.0.0.1:9999`.

Override if needed:

```bash
HOST=127.0.0.1 PORT=8888 npm start
```

## HTTP API

All endpoints return JSON. Errors use `{ "error": { "code", "message", "details" } }`.

### `GET /api/ports`

Returns all listening TCP ports with process details.

### `GET /api/ports/:port`

Returns one listening process for a TCP port, or `PORT_NOT_FOUND`.

### `POST /api/ports/kill`

**Destructive.** Dry-run by default — you must pass `confirm: true` to actually terminate.

```json
{ "pid": 12345, "port": 3000 }
```

Actually send `SIGTERM`:

```json
{ "pid": 12345, "port": 3000, "confirm": true }
```

Allow low/system ports only when explicit:

```json
{ "pid": 12345, "port": 80, "confirm": true, "allowSystemPort": true }
```

Escalate from `SIGTERM` to `SIGKILL` only when explicit:

```json
{ "pid": 12345, "port": 3000, "confirm": true, "force": true }
```

### `POST /api/ports/restart`

Always returns `RESTART_NOT_IMPLEMENTED`. Restart-by-command is intentionally omitted because accepting arbitrary command lines from MCP/HTTP clients is remote code execution.

## Development

```bash
npm test
npm run dev
```

## Security

See `SECURITY.md`. Key points:

- **Keep this bound to localhost** (`127.0.0.1`). Do not expose it to a network.
- **Command lines can contain sensitive process arguments** (passwords, tokens, file paths). Treat `list_ports` output as local/private.
- **Kill is destructive** even with guards. Double-check the PID and port before confirming.
- **Restart is disabled** until an explicit allowlist design exists.
- **Killing yourself** (the Port Manager process) is rejected by the server — you cannot shoot your own foot.

## License

MIT
