# Release Notes — Version 1.1.0

We are excited to release **version 1.1.0** of `ports-mcp`, upgrading the application from a simple port inspector to a comprehensive **macOS System Resource, Cache, Process & Safety Management Suite**. 

This release includes the Midnight Glacier visual redesign, cache cleaning capabilities, process suspension controls, real-time system metrics, and highly-refined safety modes to ensure secure execution under agentic workflows.

---

## What's New in v1.1.0

### 1. ❄️ Midnight Glacier UI Redesign
A complete design overhaul centered around a premium, modern, dark-mode visual aesthetic:
*   **Segmented Layout**: Dedicated navigation views for Ports, System Resources, Cache Cleaners, and Safety Settings.
*   **Persistent Status Footer**: A constant dashboard overview indicating server status, safety mode, active cache size, and update availability.
*   **RTL Localization**: Native support for Right-to-Left formatting (Hebrew) dynamically switching directionality (`dir="rtl"`).
*   **Micro-Animations & Premium Effects**: Smooth transitions, customized interactive buttons, and distinct styling.

### 2. 🗄️ Cache Cleaning & Disk Optimization
A brand-new utility to safely regain system storage space:
*   **Safe Scan**: Automatically detects size and status of safe-to-trash developer and user caches (including NPM, Xcode, Cargo, Gradle, Bun, etc.).
*   **Categorized Clean-up**: Groups folders into Collapsed, Accessible safety categories to review what is being deleted.
*   **System Trash Integration**: Moves cache directories to the system trash bin instead of destructive immediate deletion (`rm -rf`).
*   **Safety Guards**: Detects active lock conflicts (`ACTIVE_PROCESS_LOCK`), bypassing local cache states on success to show updated metrics.

### 3. 📊 System Resources & Process Dashboard
Monitor system health and resource consumption:
*   **Real-time Metrics**: Track system-wide CPU and Memory usage percentages directly from the dashboard and persistent footer.
*   **Top 50 Process List**: Access an active process list sorted by CPU and memory impact.
*   **Pause & Resume**: Suspend (`SIGSTOP`) and Resume (`SIGCONT`) processes to manage CPU bottlenecks, guarded by critical process protections.

### 4. 🛡️ Refined Safety & Execution Modes
New robust execution configurations designed specifically for agentic AI usage:
*   **Three Safety Modes**:
    1.  **Read-Only**: Safely blocks all destructive actions (kills, cache clearing, suspension).
    2.  **Guarded**: Prompts for confirmation on destructive actions.
    3.  **Interactive / Allowlist-Only**: Limits actions only to specified allowed ports or processes.
*   **Custom Allowlist & Blocklist**: Dynamically adjust safe/blocked lists via the settings panel.
*   **System Port Protection**: Refuses operations on system ports (`<1024`) unless explicitly overridden.
*   **Self-Kill Protection**: Prevents the Port Manager or stdio MCP server from killing itself.
*   **Rate Limiting & Cooldown**: Capped at 5 destructive operations per minute with a 3-second mandatory cooldown.

### 5. ⚡ Service Optimizations & Performance
*   **Concurrent Process Fetching**: Speeds up system metrics retrieval by fetching process details for multiple PIDs concurrently.
*   **Smart Name Translation**: Dynamically parses process names and translates them for local search support.
*   **Caching Layer**: Added service-level caching to prevent resource-heavy execution calls.
*   **Grouped Port Listings**: Port items with identical commands/PIDs are collapsed into clean, grouped lists.

### 6. 🧪 Robustness & Expanded Test Suite
*   **195 Unit and Integration Tests**: Expanded testing coverage to cover edge cases, safety configurations, UI components, caching logic, and API routes.
*   **Graceful Degredation**: Gracefully handles complete `lsof` command failures, `du` storage errors, and rate limit cooldown conflicts.

---

## New MCP Tools (For AI Agents)
Agents calling the stdio MCP server now have access to the following capabilities:
*   `verify_process_owner`: Confirms the username owning a target process.
*   `get_process_details`: Rich details (ppid, uptime, full command line, etc.).
*   `safe_kill_process`: Guarded process termination.
*   `get_safety_status`: Returns current safety settings, rate-limiter, and allowlist state.
*   `get_system_usage`: Returns system CPU and memory usage.
*   `list_system_processes`: Lists top 50 resource-heavy active processes.
*   `suspend_process` / `resume_process`: Pauses and resumes running programs.
*   `list_caches` / `clean_cache`: Scan and clear macOS user/developer caches.

---

## Upgrading

To use the new version, fetch the latest code and install dependencies:
```bash
git checkout main
git pull
npm install
```

Verify tests are passing:
```bash
npm test
```

Run the server/web UI:
```bash
npm start
```
