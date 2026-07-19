# ports-mcp — macOS Port Manager

> ⚠️ **DANGER: This tool can terminate running processes.**  
> Killing a process can cause data loss, crash running applications, or destabilise your system.  
> **Always confirm the PID and port before taking action.** This tool is safe by design (dry-run by default, guarded by explicit confirmation), but *you* are responsible for what you kill.

macOS **only** — uses `lsof` and `ps`, which are macOS-specific.

Local-only MCP server and optional web UI for inspecting macOS listening TCP ports.

Also available as a native macOS desktop app. The app runs its API only on a private
`127.0.0.1` port and opens the existing local UI in an isolated Electron window.

The priority entrypoint is the stdio MCP server for AI agents. The existing browser UI remains available for local manual use.

> Security posture: safe by default. Listing ports is read-only. Killing a process is guarded and dry-runs unless `confirm=true`. Restart is intentionally disabled until there is an explicit allowlist; the old arbitrary `shell:true` restart path was removed.

## Who this is for

- Developers who need to inspect which processes own a local TCP port.
- AI agent frameworks that need to programmatically manage port conflicts.
- **Not** for production servers, multi-user environments, or remote access.

## Features

- **Port Monitoring & Management**:
  - `list_ports` MCP tool: Lists listening TCP ports via `lsof`, enriched with `ps` command lines. Collapses identical processes and supports caching.
  - `find_process_by_port` MCP tool: Returns one listening process for a TCP port.
  - `get_process_details` MCP tool: Enriches standard lsof output with deep process information (uptime, parent PID, full command line).
  - `verify_process_owner` MCP tool: Confirms the owner of a process to protect against privilege escalation risks.
  - `kill_process_on_port` & `safe_kill_process` MCP tools: **Destructive but heavily guarded:**
    - Validates `pid` still owns the port immediately before signaling.
    - Refuses to kill the Port Manager itself.
    - Refuses system ports (`<=1024`) unless overridden.
    - Rate limited (max 5 kills/min) with cooldowns.
    - Refuses critical system processes (e.g. `launchd`, `kernel_task`).
    - Requires owner match (can only kill own user's processes).
    - Dry-runs unless `confirm=true`.
  - `restart_process_on_port` & `safe_restart_process` MCP tools: Intentionally disabled to prevent arbitrary remote code execution.
- **System Resource Monitoring**:
  - `get_system_usage` MCP tool: Returns real-time macOS CPU and Memory usage.
  - `list_system_processes` MCP tool: Returns top 50 resource-heavy active processes.
- **Process Suspension**:
  - `suspend_process` MCP tool: Pauses an active process using `SIGSTOP`. Critical processes are protected.
  - `resume_process` MCP tool: Resumes a paused process using `SIGCONT`.
- **Cache Cleaner & Storage Optimizer**:
  - `list_caches` MCP tool: Scans and lists macOS user and developer caches (NPM, Xcode, Gradle, Bun, Cargo, etc.) with sizes and safety categories.
  - `clean_cache` MCP tool: Safely moves selected cache paths to the system trash bin. Handles active locks.
- **Safety Configuration**:
  - `get_safety_status` MCP tool: Returns current safety configuration, active allowlists/blocklists, and rate-limiting counters.
- **Express Web UI**:
  - Optional web interface styled with the **Midnight Glacier** dark-theme redesign.
  - Interactive tabs for Ports list, System dashboard, Cache optimization, and dynamic Safety settings.
  - Multi-language RTL layout support (Hebrew / English).

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

## Run the macOS app

```bash
npm run desktop
```

The desktop app does not need a manually started web server. It creates an ephemeral
loopback-only server, opens the UI, and closes it when the app quits.

## Package a macOS app

```bash
npm run package:mac
```

Artifacts are written to `dist/` as a `.dmg` and `.zip` for the current Mac
architecture. Free releases use a complete ad-hoc bundle signature so macOS can
verify that the app bundle is intact, but they are not Apple-notarized.

For the first launch of an ad-hoc release:

1. Drag **Port Manager** from the DMG into **Applications**.
2. In Finder, right-click **Port Manager** and choose **Open**.
3. Choose **Open** again in the macOS confirmation dialog.

After the first approval, normal double-click launching works. Fully transparent
first-launch distribution still requires an Apple Developer ID signature and
Apple notarization.

### Update from GitHub `main`

When running the app from a Git checkout (`npm run desktop`), choose
**מנהל הפורטים → עדכון מ-GitHub main…**. The app only fast-forwards a clean
`main` checkout whose `origin` is this repository, then restarts. It refuses
local changes, a different branch, or a different origin.

Packaged `.app`/`.dmg` builds cannot update from Git: they do not contain the
repository's `.git` metadata. For installed builds, publish and download a new
signed/notarized release. A full automatic updater should use GitHub Releases,
not an arbitrary moving branch.

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

Always returns `RESTART_NOT_IMPLEMENTED`. Restart-by-command is intentionally omitted.

### `GET /api/app-info`

Returns local version and latest update available via GitHub release.

### `GET /api/system/usage`

Returns system-wide real-time CPU and Memory utilization percentages.

### `GET /api/system/storage`

Returns user/developer cache folder sizing details.

### `GET /api/system/disk`

Returns macOS physical disk capacity and current usage.

### `GET /api/system/processes`

Returns top 50 active processes sorted by resource consumption.

### `GET /api/system/cache`

Returns details of safe system caches (path, size, category, status).

### `POST /api/system/cache/trash`

**Destructive.** Trashes a targeted cache folder. Requires `path` and `confirm: true`.

### `POST /api/system/suspend`

**Destructive.** Pauses a running process using SIGSTOP. Requires `pid` and `confirm: true`.

### `POST /api/system/resume`

Resumes a paused process using SIGCONT. Requires `pid`.

### `POST /api/system/kill`

**Destructive.** Kills a specific process by PID. Requires `pid` and `confirm: true`.

### `GET /api/safety`

Returns the current safety configuration (mode, verifyOwner, allowlists/blocklists).

### `POST /api/safety/mode`

Updates safety mode. Accepts `{ "mode": "read-only" | "allowlist" | "blocklist" }`.

### `POST /api/safety/allowlist`

Manages allowlist. Accepts `{ "action": "add" | "remove", "port": number }`.

### `POST /api/safety/blocklist`

Manages blocklist. Accepts `{ "action": "add" | "remove", "port": number }`.

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
