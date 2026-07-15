# System Resource Monitoring and Process Optimization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add system-wide CPU/Memory monitoring, guided alerts for heavy processes, quick optimization, and process pause/resume functionality to the macOS Port Manager, fully guarded by system protection logic.

**Architecture:** Extend `port-service.js` to sample CPU usage and parse macOS `ps` outputs. Create new API routes `/api/system/*` in `http-server.js` and register new MCP tools. Modify the frontend UI to display system performance cards, an alert banner for heavy user apps, and a comprehensive "All Processes" view with action buttons (Terminate, Pause, Resume) showing locked states for system services.

**Tech Stack:** Node.js, Express, JavaScript, HTML, CSS.

---

### Task 1: Update Safety Layer to Handle Port-less Targets
Modify `src/safety.js` to skip port-specific checks when a process target does not listen on a port (i.e. `target.port === undefined`).

**Files:**
- Modify: `src/safety.js`
- Test: `test/safety.test.js`

- [ ] **Step 1: Write failing test**
  Add a test to verify that `checkDestructive` allows a user-owned process with no port (port is undefined) while still blocking system-owned processes or blocklisted names.
  Add this to `test/safety.test.js`:
  ```javascript
  test('SafetyLayer permits port-less process for current user but blocks system processes', async () => {
    const { SafetyConfig } = require('../src/config');
    const { SafetyLayer } = require('../src/safety');
    const config = new SafetyConfig({ mode: 'blocklist' });
    const safety = new SafetyLayer({
      config,
      currentUser: 'yonig',
      selfPid: 9999
    });

    // Safe user process with undefined port
    const userProc = { pid: 1234, processName: 'node', user: 'yonig', isSystem: false };
    const res1 = await safety.checkDestructive(userProc);
    assert.equal(res1.ok, true);

    // System process with undefined port
    const sysProc = { pid: 1, processName: 'launchd', user: 'root', isSystem: true };
    const res2 = await safety.checkDestructive(sysProc);
    assert.equal(res2.ok, false);
    assert.equal(res2.check, 'system_process');
  });
  ```

- [ ] **Step 2: Run test to verify it fails**
  Run: `node --test test/safety.test.js`
  Expected: FAIL with undefined port errors or mode checks failing.

- [ ] **Step 3: Modify `src/safety.js`**
  Modify the `checkDestructive` method in `src/safety.js` around line 157:
  ```javascript
  // === 2. Allowlist / Blocklist ===
  if (target.port !== undefined) {
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
  if (target.port !== undefined && target.port < 1024 && allowSystemPort !== true) {
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
  ```

- [ ] **Step 4: Run test to verify it passes**
  Run: `node --test test/safety.test.js`
  Expected: PASS

- [ ] **Step 5: Commit changes**
  ```bash
  git add src/safety.js test/safety.test.js
  git commit -m "feat: support port-less processes in safety checks"
  ```

---

### Task 2: Implement CPU and Memory Monitoring in Port Service
Add helper functions to calculate system CPU and memory, parse `ps` output, and handle process termination/suspension.

**Files:**
- Modify: `src/port-service.js`
- Test: `test/port-service.test.js`

- [ ] **Step 1: Write failing tests**
  Add tests for `getSystemUsage`, `getSystemProcesses`, `suspendProcess`, and `resumeProcess`.
  Add to `test/port-service.test.js`:
  ```javascript
  const os = require('node:os');

  test('getSystemUsage returns CPU and memory statistics', async () => {
    const service = createPortService();
    const usage = await service.getSystemUsage();
    assert.ok(typeof usage.cpu === 'number');
    assert.ok(typeof usage.memory.percentage === 'number');
    assert.ok(usage.memory.totalBytes > 0);
  });

  test('getSystemProcesses parses ps output correctly', async () => {
    const psStdout = ` %CPU   RSS STAT   PID USER COMM
 12.5 1048576 S   1234 yoni /Applications/Google Chrome.app/Contents/MacOS/Google Chrome
  0.0  51200 T   5678 yoni /usr/local/bin/node
  1.5 2048000 R      1 root /sbin/launchd
`;
    const runner = {
      execFile: async () => ({ stdout: psStdout, stderr: '', exitCode: 0 })
    };
    const service = createPortService({ runner, currentUser: 'yoni' });
    const list = await service.getSystemProcesses();

    assert.equal(list.length, 3);
    assert.equal(list[0].pid, 1234);
    assert.equal(list[0].processName, 'Google Chrome');
    assert.equal(list[0].cpu, 12.5);
    assert.equal(list[0].memoryMb, 1024.0);
    assert.equal(list[0].isSuspended, false);
    assert.equal(list[0].isSystem, false);

    assert.equal(list[1].pid, 5678);
    assert.equal(list[1].isSuspended, true);

    assert.equal(list[2].pid, 1);
    assert.equal(list[2].isSystem, true);
  });
  ```

- [ ] **Step 2: Run tests to verify they fail**
  Run: `node --test test/port-service.test.js`
  Expected: FAIL with functions undefined

- [ ] **Step 3: Implement methods in `src/port-service.js`**
  Modify `src/port-service.js` to import `os` and implement functions inside `createPortService`.
  At the top of the file:
  ```javascript
  const os = require('node:os');
  ```
  Inside `createPortService(options = {})`:
  ```javascript
  async function getSystemUsage() {
    const totalBytes = os.totalmem();
    const freeBytes = os.freemem();
    const usedBytes = totalBytes - freeBytes;
    const memoryPercentage = parseFloat(((usedBytes / totalBytes) * 100).toFixed(1));

    // Dynamic CPU calculation by sampling os.cpus()
    const cpus1 = os.cpus();
    await new Promise(r => setTimeout(r, 150));
    const cpus2 = os.cpus();

    let idleDiff = 0;
    let totalDiff = 0;
    for (let i = 0; i < cpus1.length; i++) {
      const t1 = cpus1[i].times;
      const t2 = cpus2[i].times;
      const idle = t2.idle - t1.idle;
      const user = t2.user - t1.user;
      const sys = t2.sys - t1.sys;
      const irq = t2.irq - t1.irq;
      const nice = t2.nice - t1.nice;
      idleDiff += idle;
      totalDiff += idle + user + sys + irq + nice;
    }
    const cpuPercentage = totalDiff === 0 ? 0 : parseFloat(((1 - idleDiff / totalDiff) * 100).toFixed(1));

    return {
      cpu: cpuPercentage,
      memory: {
        usedBytes,
        totalBytes,
        percentage: memoryPercentage
      }
    };
  }

  async function getSystemProcesses() {
    const { stdout } = await runner.execFile('ps', ['-A', '-o', 'pcpu,rss,state,pid,user,comm'], { allowNonZero: true });
    const lines = stdout.trim().split('\n').slice(1);
    const processes = [];

    for (const line of lines) {
      const parts = line.trim().split(/\s+/);
      if (parts.length < 6) continue;
      const cpu = parseFloat(parts[0]);
      const rss = parseInt(parts[1], 10);
      const state = parts[2];
      const pid = parseInt(parts[3], 10);
      const user = parts[4];
      const commandLine = parts.slice(5).join(' ');

      if (Number.isNaN(pid)) continue;

      const baseName = commandLine.split('/').pop() || 'Unknown';
      const processName = baseName.replace(/\.app\/Contents\/MacOS\/.+$/, '').replace(/\.app$/, '');
      const isSuspended = state.includes('T');

      const procObj = {
        pid,
        processName,
        cpu,
        memoryMb: parseFloat((rss / 1024).toFixed(1)),
        user,
        isSuspended,
        commandLine,
      };

      procObj.isSystem = isSystemProcess(procObj);
      processes.push(procObj);
    }

    // Sort by CPU desc, limit to 50
    return processes.sort((a, b) => b.cpu - a.cpu || b.memoryMb - a.memoryMb).slice(0, 50);
  }

  async function suspendProcess({ pid }) {
    const normalizedPid = validateInteger('pid', pid, { min: 1 });
    const processes = await getSystemProcesses();
    const target = processes.find(p => p.pid === normalizedPid);
    if (!target) throw new PortManagerError('PROCESS_NOT_FOUND', `Process PID ${normalizedPid} not found`, { status: 404 });

    await runSafetyCheck(target);

    if (normalizedPid === selfPid) {
      throw new PortManagerError('REFUSE_SELF', 'Refusing to suspend Port Manager itself', { status: 403 });
    }

    killFn(normalizedPid, 'SIGSTOP');
    auditLog({ action: 'suspend', pid: normalizedPid, processName: target.processName, user: target.user });
    return { ok: true, pid: normalizedPid, processName: target.processName };
  }

  async function resumeProcess({ pid }) {
    const normalizedPid = validateInteger('pid', pid, { min: 1 });
    const processes = await getSystemProcesses();
    const target = processes.find(p => p.pid === normalizedPid);
    if (!target) throw new PortManagerError('PROCESS_NOT_FOUND', `Process PID ${normalizedPid} not found`, { status: 404 });

    await runSafetyCheck(target);

    killFn(normalizedPid, 'SIGCONT');
    auditLog({ action: 'resume', pid: normalizedPid, processName: target.processName, user: target.user });
    return { ok: true, pid: normalizedPid, processName: target.processName };
  }

  async function killProcess({ pid, confirm = false }) {
    const normalizedPid = validateInteger('pid', pid, { min: 1 });
    const processes = await getSystemProcesses();
    const target = processes.find(p => p.pid === normalizedPid);
    if (!target) throw new PortManagerError('PROCESS_NOT_FOUND', `Process PID ${normalizedPid} not found`, { status: 404 });

    await runSafetyCheck(target);

    if (normalizedPid === selfPid) {
      throw new PortManagerError('REFUSE_SELF', 'Refusing to terminate Port Manager itself', { status: 403 });
    }

    if (confirm !== true) {
      return { dryRun: true, wouldSignal: 'SIGTERM', target };
    }

    killFn(normalizedPid, 'SIGTERM');
    auditLog({ action: 'kill-system-process', pid: normalizedPid, processName: target.processName, user: target.user });
    return { dryRun: false, signalSent: 'SIGTERM', target };
  }
  ```
  Expose these functions in the returned object at the bottom of `createPortService`:
  ```javascript
  return {
    listPorts,
    findProcessByPort,
    killProcessOnPort,
    restartProcessOnPort,
    getSystemUsage,
    getSystemProcesses,
    suspendProcess,
    resumeProcess,
    killProcess
  };
  ```

- [ ] **Step 4: Run tests to verify they pass**
  Run: `node --test test/port-service.test.js`
  Expected: PASS

- [ ] **Step 5: Commit changes**
  ```bash
  git add src/port-service.js test/port-service.test.js
  git commit -m "feat: add CPU/Memory usage gathering, ps output parsing, and process suspension to port-service"
  ```

---

### Task 3: Expose HTTP REST Endpoints
Add new routes to `src/http-server.js` for CPU/Memory and process controls.

**Files:**
- Modify: `src/http-server.js`
- Test: `test/ui-safety.test.js` (or create integration tests)

- [ ] **Step 1: Write failing integration test**
  Add testing for new routes. Create `test/system-routes.test.js`:
  ```javascript
  const test = require('node:test');
  const assert = require('node:assert/strict');
  const { createApp } = require('../src/http-server');

  test('GET /api/system/usage returns stats', async () => {
    const serviceMock = {
      getSystemUsage: async () => ({ cpu: 10, memory: { percentage: 50, usedBytes: 1000, totalBytes: 2000 } })
    };
    const app = createApp({ service: serviceMock });

    // Simple routing check using local server start/fetch or mocked requests
    // Using mock check
  });
  ```

- [ ] **Step 2: Run integration tests**
  Run: `node --test`
  Expected: Fail/Error

- [ ] **Step 3: Modify `src/http-server.js`**
  Add the following routes in `src/http-server.js` inside `createApp()`:
  ```javascript
  app.get('/api/system/usage', async (_req, res) => {
    try {
      const usage = await service.getSystemUsage();
      res.json(usage);
    } catch (error) {
      sendError(res, error);
    }
  });

  app.get('/api/system/processes', async (_req, res) => {
    try {
      const processes = await service.getSystemProcesses();
      res.json({ processes });
    } catch (error) {
      sendError(res, error);
    }
  });

  app.post('/api/system/suspend', async (req, res) => {
    try {
      const { pid } = req.body || {};
      const result = await service.suspendProcess({ pid });
      res.json(result);
    } catch (error) {
      sendError(res, error);
    }
  });

  app.post('/api/system/resume', async (req, res) => {
    try {
      const { pid } = req.body || {};
      const result = await service.resumeProcess({ pid });
      res.json(result);
    } catch (error) {
      sendError(res, error);
    }
  });

  app.post('/api/system/kill', async (req, res) => {
    try {
      const { pid, confirm } = req.body || {};
      const result = await service.killProcess({ pid, confirm });
      res.json(result);
    } catch (error) {
      sendError(res, error);
    }
  });
  ```

- [ ] **Step 4: Run all tests to verify passing**
  Run: `npm test`
  Expected: PASS

- [ ] **Step 5: Commit changes**
  ```bash
  git add src/http-server.js
  git commit -m "feat: expose system resource and process control endpoints"
  ```

---

### Task 4: Add MCP Server Tools
Expose the new features as MCP tools in `src/mcp-server.js`.

**Files:**
- Modify: `src/mcp-server.js`
- Test: `test/tools.test.js`

- [ ] **Step 1: Write failing test**
  Add tests for `get_system_usage`, `list_system_processes`, `suspend_process`, `resume_process` to `test/tools.test.js`.

- [ ] **Step 2: Run tests to verify they fail**
  Run: `node --test test/tools.test.js`
  Expected: FAIL

- [ ] **Step 3: Modify `src/mcp-server.js`**
  Register the tools:
  ```javascript
  server.registerTool(
    'get_system_usage',
    {
      title: 'Get system CPU and memory usage',
      description: 'Returns real-time usage percentages for system-wide CPU and memory.',
      inputSchema: {}
    },
    withTimeout(async () => {
      try {
        return jsonText(await service.getSystemUsage());
      } catch (error) {
        return errorResult(error);
      }
    }, 'get_system_usage')
  );

  server.registerTool(
    'list_system_processes',
    {
      title: 'List resource-heavy system processes',
      description: 'Returns the top 50 resource-heavy active processes running on macOS, indicating which are system processes.',
      inputSchema: {}
    },
    withTimeout(async () => {
      try {
        return jsonText({ processes: await service.getSystemProcesses() });
      } catch (error) {
        return errorResult(error);
      }
    }, 'list_system_processes')
  );

  server.registerTool(
    'suspend_process',
    {
      title: 'Suspend/Pause a process',
      description: 'Suspends an active process using SIGSTOP. Requires PID. Critical system processes are protected.',
      inputSchema: {
        pid: z.number().int().min(1)
      }
    },
    withTimeout(async ({ pid }) => {
      try {
        return jsonText(await service.suspendProcess({ pid }));
      } catch (error) {
        return errorResult(error);
      }
    }, 'suspend_process')
  );

  server.registerTool(
    'resume_process',
    {
      title: 'Resume/Wake up a suspended process',
      description: 'Resumes a suspended process using SIGCONT. Requires PID.',
      inputSchema: {
        pid: z.number().int().min(1)
      }
    },
    withTimeout(async ({ pid }) => {
      try {
        return jsonText(await service.resumeProcess({ pid }));
      } catch (error) {
        return errorResult(error);
      }
    }, 'resume_process')
  );
  ```

- [ ] **Step 4: Run tests to verify they pass**
  Run: `npm test`
  Expected: PASS

- [ ] **Step 5: Commit changes**
  ```bash
  git add src/mcp-server.js
  git commit -m "feat: register get_system_usage, list_system_processes, suspend_process, resume_process MCP tools"
  ```

---

### Task 5: Build Web UI Features
Update HTML structure, style sheet, and UI controller to support system resource metrics cards, warning alerts, quick clean, and the manual system processes list with Pause/Resume/Terminate controls.

**Files:**
- Modify: `public/index.html`
- Modify: `public/style.css`
- Modify: `public/app.js`

- [ ] **Step 1: Modify HTML Layout in `public/index.html`**
  Add the CPU and Memory metrics cards inside `.metrics-grid` (around line 97):
  ```html
  <div class="metric-card glass">
    <div class="metric-icon system-icon">💻</div>
    <div class="metric-content">
      <h3>עומס מעבד (CPU)</h3>
      <p id="metric-cpu-usage" class="metric-value">--%</p>
      <div class="progress-bar-container"><div id="cpu-bar" class="progress-bar" style="width: 0%"></div></div>
    </div>
  </div>
  <div class="metric-card glass">
    <div class="metric-icon dev-icon">🧠</div>
    <div class="metric-content">
      <h3>ניצול זיכרון</h3>
      <p id="metric-memory-usage" class="metric-value">-- GB</p>
      <div class="progress-bar-container"><div id="memory-bar" class="progress-bar" style="width: 0%"></div></div>
    </div>
  </div>
  ```
  Add a placeholder container for the Warning Banner right before the controls panel (around line 121):
  ```html
  <!-- Dynamic Warning Banner -->
  <section id="warning-banner" class="warning-banner glass hidden">
    <div class="warning-header">
      <span class="warning-icon">⚠️</span>
      <div class="warning-title">
        <h3>זוהה עומס כבד במערכת</h3>
        <p id="warning-message">המחשב פועל בטמפרטורה גבוהה. מומלץ לסגור או להשהות את התהליכים הבאים:</p>
      </div>
      <button id="quick-clean-btn" class="btn btn-danger">🗑️ אופטימיזציה מהירה</button>
    </div>
    <div id="warning-suggestions" class="warning-suggestions"></div>
  </section>
  ```
  Add a filter button in the filter-tabs (around line 131):
  ```html
  <button class="filter-tab" data-filter="system-resources">משאבי מערכת</button>
  ```

- [ ] **Step 2: Modify `public/style.css`**
  Add layout, alert banner, suggestions, and table styles:
  ```css
  /* Progress bars inside cards */
  .progress-bar-container {
    width: 100%;
    height: 6px;
    background: rgba(255, 255, 255, 0.1);
    border-radius: 3px;
    margin-top: 8px;
    overflow: hidden;
  }
  .progress-bar {
    height: 100%;
    width: 0%;
    background: var(--primary-color, #00d2ff);
    transition: width 0.5s ease, background-color 0.5s ease;
  }
  /* Warning banner */
  .warning-banner {
    border: 1px solid rgba(255, 75, 75, 0.3);
    background: rgba(255, 75, 75, 0.05);
    border-radius: 12px;
    padding: 16px;
    margin-bottom: 20px;
    backdrop-filter: blur(10px);
  }
  .warning-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 16px;
  }
  .warning-icon {
    font-size: 24px;
  }
  .warning-title h3 {
    margin: 0;
    color: #ff4b4b;
    font-size: 1.1rem;
  }
  .warning-title p {
    margin: 4px 0 0 0;
    font-size: 0.9rem;
    color: var(--text-secondary, #aaa);
  }
  .warning-suggestions {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
    gap: 12px;
    margin-top: 16px;
    border-top: 1px solid rgba(255, 255, 255, 0.05);
    padding-top: 12px;
  }
  .suggestion-card {
    background: rgba(255, 255, 255, 0.03);
    border: 1px solid rgba(255, 255, 255, 0.05);
    border-radius: 8px;
    padding: 12px;
    display: flex;
    justify-content: space-between;
    align-items: center;
  }
  .suggestion-info h4 {
    margin: 0;
    font-size: 0.95rem;
  }
  .suggestion-info p {
    margin: 4px 0 0 0;
    font-size: 0.8rem;
    color: var(--text-secondary, #aaa);
  }
  .badge-suspended {
    background: rgba(255, 193, 7, 0.15);
    color: #ffc107;
    padding: 2px 6px;
    border-radius: 4px;
    font-size: 0.75rem;
  }
  ```

- [ ] **Step 3: Modify controller logic in `public/app.js`**
  Hook up periodic polling, system processes table switching, and action buttons.
  - Implement polling function:
    ```javascript
    async function updateSystemUsage() {
      try {
        const res = await fetch('/api/system/usage');
        if (!res.ok) return;
        const data = await res.json();
        
        // Update metric display
        document.getElementById('metric-cpu-usage').textContent = `${data.cpu}%`;
        const cpuBar = document.getElementById('cpu-bar');
        cpuBar.style.width = `${data.cpu}%`;
        cpuBar.style.backgroundColor = data.cpu > 80 ? '#ff4b4b' : data.cpu > 50 ? '#ffc107' : '#00e676';
        
        const usedGb = (data.memory.usedBytes / (1024 ** 3)).toFixed(2);
        const totalGb = (data.memory.totalBytes / (1024 ** 3)).toFixed(2);
        document.getElementById('metric-memory-usage').textContent = `${usedGb} GB / ${totalGb} GB`;
        
        const memoryBar = document.getElementById('memory-bar');
        memoryBar.style.width = `${data.memory.percentage}%`;
        memoryBar.style.backgroundColor = data.memory.percentage > 85 ? '#ff4b4b' : data.memory.percentage > 70 ? '#ffc107' : '#00e676';

        // Check if banner should be displayed
        if (data.cpu > 70 || data.memory.percentage > 80) {
          await renderWarningBanner();
        } else {
          document.getElementById('warning-banner').classList.add('hidden');
        }
      } catch (err) {
        console.error('Failed to update system metrics:', err);
      }
    }
    ```
  - Implement process list rendering under the "System Resources" tab:
    ```javascript
    async function fetchAndRenderSystemResources() {
      const res = await fetch('/api/system/processes');
      if (!res.ok) return;
      const { processes } = await res.json();
      
      const tbody = document.getElementById('ports-table-body');
      tbody.innerHTML = '';
      
      processes.forEach(proc => {
        const row = document.createElement('tr');
        if (proc.isSuspended) row.classList.add('row-suspended');
        
        const actionsHtml = proc.isSystem 
          ? `<span class="badge badge-system-lock">🔒 מוגן מערכת</span>`
          : `
            <div class="action-btn-group">
              ${proc.isSuspended 
                ? `<button class="btn btn-sm btn-success btn-resume-proc" data-pid="${proc.pid}">▶️ המשך</button>` 
                : `<button class="btn btn-sm btn-warning btn-pause-proc" data-pid="${proc.pid}">⏸️ השהה</button>`}
              <button class="btn btn-sm btn-danger btn-kill-proc" data-pid="${proc.pid}" data-name="${proc.processName}">❌ סגור</button>
            </div>
          `;
        
        row.innerHTML = `
          <td>-</td>
          <td><strong>${proc.processName}</strong></td>
          <td class="font-mono">${proc.pid}</td>
          <td>${proc.user}</td>
          <td>-</td>
          <td>${proc.isSuspended ? '<span class="badge-suspended">מושהה (Suspended)</span>' : 'פעיל (Running)'}</td>
          <td>${proc.cpu}% CPU / ${proc.memoryMb} MB</td>
          <td class="text-right">${actionsHtml}</td>
        `;
        tbody.appendChild(row);
      });
    }
    ```
  - Hook event handlers in `public/app.js` for resume, pause, and kill process events.
  - Setup polling interval: `setInterval(updateSystemUsage, 4000);` and call `updateSystemUsage()` on startup.

- [ ] **Step 4: Verify UI locally**
  Deploy server using `npm run dev` and navigate to `http://127.0.0.1:9999` using web browser. Validate tabs, alerts, list, and buttons work as specified.

- [ ] **Step 5: Commit changes**
  ```bash
  git add public/index.html public/style.css public/app.js
  git commit -m "feat: implement system resources widgets, warning banner, and manual process management in Web UI"
  ```
