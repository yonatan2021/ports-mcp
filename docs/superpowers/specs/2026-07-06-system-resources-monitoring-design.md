# System Resource Monitoring and Process Optimization Design Spec

## Goal Description
Add comprehensive system-wide and per-process CPU and memory monitoring to the macOS Port Manager app. Provide guided warnings for high resource usage, a "Quick Optimization" button to terminate heavy non-critical user-owned processes, and a detailed "All Processes" view with built-in safety controls to protect critical macOS system services.

---

## User Review Required
No breaking changes to existing port management features. All safety features (mode configuration, owner verification, process blocklists, rate limiting) will apply to new process termination flows.

---

## Proposed System Architecture & Changes

### Component 1: Backend Services (`src/port-service.js`)
We will add system-wide and process-level resource metrics gathering to `port-service.js`.

1. **System-wide CPU Usage Calculation**:
   - Sample `os.cpus()` times over a short interval (e.g., 300ms) or maintain previous tick readings to calculate system-wide active CPU percentage:
     $$\text{CPU \%} = \left(1 - \frac{\Delta\text{idle}}{\Delta\text{total}}\right) \times 100$$
2. **System-wide Memory Usage**:
   - Query `os.totalmem()` and `os.freemem()` to calculate active memory in bytes and usage percentage.
3. **Per-Process Resource Usage Listing**:
   - Execute macOS-specific `ps` CLI tool: `ps -A -o pcpu,rss,pid,user,comm`
   - Parse stdout:
     - `pcpu`: CPU percentage (e.g., `45.2`)
     - `rss`: Resident Set Size in Kilobytes. Convert to Megabytes: $\text{MB} = \text{rss} / 1024$.
     - `pid`: Process identifier.
     - `user`: Process owner.
     - `comm`: Executable command path (e.g., `/Applications/Slack.app/Contents/MacOS/Slack`).
   - Map command path to a friendly name (e.g., base name `Slack`).
   - Enrich process list with `isSystem` boolean flag by checking against the existing safety blocklist and user criteria:
     - `user === 'root'` or starts with `_`.
     - Executable starts with `/System/`, `/usr/libexec/`, or `/usr/sbin/`.
     - Name matches `CRITICAL_PROCESS_NAMES` or `isSystemProcess()` conditions.
   - Sort processes by CPU or memory usage. Cap at 50 processes.

---

### Component 2: HTTP API Endpoints (`src/http-server.js`)
Add new REST API endpoints to serve resource data to the frontend:
- **`GET /api/system/usage`**:
  Returns system-wide stats:
  ```json
  {
    "cpu": 45.2,
    "memory": {
      "usedBytes": 10200555520,
      "totalBytes": 17179869184,
      "percentage": 59.37
    }
  }
  ```
- **`GET /api/system/processes`**:
  Returns sorted list of top processes:
  ```json
  {
    "processes": [
      {
        "pid": 5820,
        "processName": "Google Chrome",
        "cpu": 15.2,
        "memoryMb": 850.5,
        "user": "yonig",
        "isSystem": false,
        "commandLine": "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
      }
    ]
  }
  ```
- **`POST /api/ports/kill`** (Existing):
  Reuse this endpoint to terminate heavy processes. It validates that the PID belongs to the current user (if `verifyOwner` is active), is not on the process blocklist, and adheres to rate limits/cooldowns.

---

### Component 3: MCP Server Tools (`src/mcp-server.js`)
Register new read-only tools to allow AI clients to monitor system resource status:
- **`get_system_usage`**: Returns system-wide CPU and memory percentages.
- **`list_system_processes`**: Returns top resource-consuming processes.
- **`safe_kill_process`** (Existing): Reuse to allow terminating a heavy process.

---

### Component 4: Web UI (`public/index.html`, `public/app.js`, `public/style.css`)
Modify the web interface to display metrics and options:
1. **Metrics Cards (Header Area)**:
   - Add two new widgets beside the existing port counts:
     - **CPU Meter**: Circular or bar-based percent indicator.
     - **Memory Meter**: Horizontal progress bar showing GB used/total.
     - Dynamic styling: Green (<50%), Orange (50-80%), Red (>80%).
2. **Guided Warning Banner (Alert Panel)**:
   - Display a floating glassmorphism banner when CPU > 70% or Memory > 80%.
   - Message: *"⚠️ High system usage detected. Your Mac is running hot."*
   - Suggest the top 1-2 heavy non-system user processes (e.g., *"Google Chrome is using 85% CPU. Terminating it may cool down your Mac."*).
   - Show a quick **"Terminate App"** button next to each suggestion.
   - Show a **"Quick Clean"** button to terminate all listed heavy non-system user processes after confirmation.
3. **"System Resources" Tab in Table View**:
   - Add a filter button: "System Resources" (כל התהליכים במערכת).
   - When active, populate the table with the output of `/api/system/processes`.
   - Update headers to: `Name`, `PID`, `User`, `CPU %`, `Memory (MB)`, `Actions`.
   - **Safety Protections**:
     - For non-system processes: show standard red "Terminate" button. Trigger existing PID verification modal before killing.
     - For system processes: disable/grey out button, show a lock icon 🔒 and text "System Protected" (מוגן מערכת).

---

## Verification Plan

### Automated Tests
- Create unit tests verifying CPU sampling math.
- Create unit tests for parsing macOS `ps` command output and verifying that system blocklisted processes are correctly labeled as `isSystem: true`.

### Manual Verification
- Deploy and verify the API endpoints return correct system data.
- Run a heavy process (e.g., `yes > /dev/null &` or a memory-allocation script) and check that:
  1. The CPU/memory cards update correctly in real-time.
  2. The warning banner appears automatically and identifies the heavy process.
  3. Clicking "Terminate" on the heavy process successfully kills it after entering the correct PID.
  4. System processes (like `kernel_task` or `launchd`) cannot be terminated and show lock icons in the UI.
