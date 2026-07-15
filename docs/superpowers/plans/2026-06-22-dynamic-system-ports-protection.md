# Dynamic System Ports Protection Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement dynamic system process classification on macOS to protect critical OS services while enabling port termination for user-run development processes, changing the default security mode to `blocklist`.

**Architecture:** Enrich the port listing service to determine system classification dynamically based on user ownership (e.g. root or `_` prefixed accounts), command line path, and critical process name lists. Integrate this classification into the safety layer checks and the UI representation.

**Tech Stack:** Node.js, Express, HTML/CSS/JavaScript (Vanilla).

---

### Task 1: Add Dynamic Classification Helper to `src/port-service.js`

**Files:**
- Modify: `src/port-service.js`
- Test: `test/port-service.test.js`

- [ ] **Step 1: Write a unit test for the classification helper**
  Open [test/port-service.test.js](file:///Users/yonig/Desktop/projects/ports/test/port-service.test.js) and add tests for `isSystemProcess`.
  
  ```javascript
  // Add to test/port-service.test.js
  const { isSystemProcess } = require('../src/port-service');

  test('isSystemProcess correctly identifies system and user processes', () => {
    // 1. System user should be system process
    assert.equal(isSystemProcess({ user: 'root', processName: 'node', commandLine: 'node' }), true);
    assert.equal(isSystemProcess({ user: '_windowserver', processName: 'WindowServer', commandLine: 'WindowServer' }), true);

    // 2. System path should be system process
    assert.equal(isSystemProcess({ user: 'yonig', processName: 'rapportd', commandLine: '/usr/libexec/rapportd' }), true);
    assert.equal(isSystemProcess({ user: 'yonig', processName: 'launchd', commandLine: '/System/Library/CoreServices/launchd' }), true);

    // 3. System process name should be system process
    assert.equal(isSystemProcess({ user: 'yonig', processName: 'WindowServer', commandLine: 'WindowServer' }), true);

    // 4. Custom developer process should NOT be system process
    assert.equal(isSystemProcess({ user: 'yonig', processName: 'node', commandLine: 'node server.js' }), false);
    assert.equal(isSystemProcess({ user: 'yonig', processName: 'python3', commandLine: 'python3 -m http.server' }), false);
  });
  ```

- [ ] **Step 2: Run test to verify it fails**
  Run: `node --test test/port-service.test.js`
  Expected: FAIL (Cannot find modules or `isSystemProcess` undefined).

- [ ] **Step 3: Implement `isSystemProcess` and export it**
  Open [src/port-service.js](file:///Users/yonig/Desktop/projects/ports/src/port-service.js) and implement:
  
  ```javascript
  // Implement in src/port-service.js
  function isSystemProcess(portObj) {
    const user = portObj.user;
    if (user && (user === 'root' || user.startsWith('_'))) {
      return true;
    }

    const cmd = portObj.commandLine || '';
    if (
      cmd.startsWith('/System/') ||
      cmd.startsWith('/usr/libexec/') ||
      cmd.startsWith('/usr/sbin/')
    ) {
      return true;
    }

    const name = (portObj.processName || '').toLowerCase();
    const isCritical = PROCESS_BLOCKLIST.has(name) ||
                       name === 'controlcenter' ||
                       name === 'control center' ||
                       name === 'windowserver';
    if (isCritical) {
      return true;
    }

    return false;
  }
  ```
  Export `isSystemProcess` at the bottom of the file in `module.exports`.

- [ ] **Step 4: Run test to verify it passes**
  Run: `node --test test/port-service.test.js`
  Expected: PASS.

- [ ] **Step 5: Commit changes**
  Run:
  ```bash
  git add src/port-service.js test/port-service.test.js
  git commit -m "feat: add dynamic system process classification helper"
  ```

---

### Task 2: Update `listPorts` to Enrich Results with `isSystem`

**Files:**
- Modify: `src/port-service.js`
- Test: `test/port-service.test.js`

- [ ] **Step 1: Write a unit test for enriched listPorts**
  Update tests in `test/port-service.test.js` to assert `listPorts()` contains `isSystem` field.
  
  ```javascript
  test('listPorts enriches results with isSystem', async () => {
    const service = createPortService({
      listPorts: async () => [
        { port: 3000, pid: 123, processName: 'node', user: 'yonig', type: 'IPv4', protocol: 'TCP', address: '*:3000', commandLine: 'node server.js' },
        { port: 7000, pid: 456, processName: 'ControlCenter', user: 'yonig', type: 'IPv4', protocol: 'TCP', address: '*:7000', commandLine: '/System/Library/CoreServices/ControlCenter.app/Contents/MacOS/ControlCenter' }
      ]
    });
    const ports = await service.listPorts();
    assert.equal(ports[0].isSystem, false);
    assert.equal(ports[1].isSystem, true);
  });
  ```

- [ ] **Step 2: Run test to verify it fails**
  Run: `node --test test/port-service.test.js`
  Expected: FAIL (`isSystem` is undefined).

- [ ] **Step 3: Modify `listPorts` in `src/port-service.js`**
  Find `listPorts()` in [src/port-service.js](file:///Users/yonig/Desktop/projects/ports/src/port-service.js#L124) and update:
  
  ```javascript
  // Change mapping logic to include isSystem:
  let results = ports.map(p => {
    const commandLine = commandMap[p.pid] || 'Unknown command';
    const enriched = { ...p, commandLine };
    return { ...enriched, isSystem: isSystemProcess(enriched) };
  }).sort((a, b) => a.port - b.port || a.pid - b.pid);
  ```

- [ ] **Step 4: Run test to verify it passes**
  Run: `node --test test/port-service.test.js`
  Expected: PASS.

- [ ] **Step 5: Commit changes**
  Run:
  ```bash
  git add src/port-service.js test/port-service.test.js
  git commit -m "feat: enrich listPorts results with isSystem property"
  ```

---

### Task 3: Block Destructive Actions on `isSystem` Processes in `SafetyLayer`

**Files:**
- Modify: `src/safety.js`
- Test: `test/safety.test.js`

- [ ] **Step 1: Write a unit test for SafetyLayer blocking system processes**
  Add a test to [test/safety.test.js](file:///Users/yonig/Desktop/projects/ports/test/safety.test.js):
  
  ```javascript
  test('SafetyLayer blocks destructive ops on processes flagged as isSystem', async () => {
    const config = new SafetyConfig({ mode: 'blocklist' });
    const layer = new SafetyLayer({ config, currentUser: 'yonig' });
    const target = { port: 7000, pid: 12345, processName: 'ControlCenter', user: 'yonig', isSystem: true };

    const result = await layer.checkDestructive(target);
    assert.equal(result.ok, false);
    assert.equal(result.check, 'system_process');
    assert.ok(result.reason.includes('system process'));
  });
  ```

- [ ] **Step 2: Run test to verify it fails**
  Run: `node --test test/safety.test.js`
  Expected: FAIL.

- [ ] **Step 3: Update `checkDestructive` in `src/safety.js`**
  Open [src/safety.js](file:///Users/yonig/Desktop/projects/ports/src/safety.js) and add the system process check under dynamic classification (e.g. before rate limiting or process name blocklist checks):
  
  ```javascript
  // === 4b. Dynamic System Process protection ===
  if (target.isSystem === true) {
    return {
      ok: false,
      check: 'system_process',
      reason: `Process "${target.processName}" is identified as a macOS system process and cannot be terminated.`,
      details: { processName: target.processName, pid: target.pid }
    };
  }
  ```

- [ ] **Step 4: Run test to verify it passes**
  Run: `node --test test/safety.test.js`
  Expected: PASS.

- [ ] **Step 5: Commit changes**
  Run:
  ```bash
  git add src/safety.js test/safety.test.js
  git commit -m "feat: check isSystem in SafetyLayer to prevent terminating system processes"
  ```

---

### Task 4: Change Default Security Mode to `blocklist`

**Files:**
- Modify: `src/config.js`
- Modify: `test/safety.test.js`

- [ ] **Step 1: Update tests in `test/safety.test.js`**
  Update tests in [test/safety.test.js](file:///Users/yonig/Desktop/projects/ports/test/safety.test.js) that assume the default mode is `read-only`:
  - `SafetyConfig defaults to blocklist mode with system port blocklist` (Line 12)
  - `SafetyConfig falls back to blocklist on invalid mode` (Line 64)
  - `SafetyConfig allows runtime mode switching` (Line 91)
  - `SafetyConfig toJSON returns sorted arrays` (Line 136)
  
  Replace `'read-only'` assertions with `'blocklist'` where appropriate.

- [ ] **Step 2: Run tests to verify they fail**
  Run: `node --test test/safety.test.js`
  Expected: FAIL due to config mode default still being `read-only`.

- [ ] **Step 3: Modify `DEFAULTS.mode` in `src/config.js`**
  Open [src/config.js](file:///Users/yonig/Desktop/projects/ports/src/config.js) and modify the default mode:
  
  ```javascript
  const DEFAULTS = {
    /** Permission mode: 'read-only' | 'allowlist' | 'blocklist' */
    mode: 'blocklist',
    ...
  ```

- [ ] **Step 4: Run tests to verify they pass**
  Run: `node --test test/safety.test.js`
  Expected: PASS.

- [ ] **Step 5: Commit changes**
  Run:
  ```bash
  git add src/config.js test/safety.test.js
  git commit -m "config: set default safety mode to blocklist"
  ```

---

### Task 5: Update Frontend (UI, app.js, index.html)

**Files:**
- Modify: `public/app.js`
- Modify: `public/index.html`

- [ ] **Step 1: Update `killDisabled` calculation in `public/app.js`**
  Open [public/app.js](file:///Users/yonig/Desktop/projects/ports/public/app.js) and replace the hardcoded port-based checks with the dynamic `portObj.isSystem` check.
  
  ```javascript
  // Around line 382:
  const isSelf = portNumber === selfPort;
  const isReadOnlyMode = typeof window.SafetySettings !== 'undefined' && !window.SafetySettings.canKill();
  const killDisabled = isSelf || portObj.isSystem || isReadOnlyMode;
  
  const killDisabledReason = isSelf
    ? 'הגנה עצמית: זהו שרת מנהל הפורטים הנוכחי ולא ניתן לסגור אותו.'
    : portObj.isSystem
      ? 'הגנת תהליכי מערכת: תהליך זה מוגדר כחלק ממערכת ההפעלה של macOS ולא ניתן לסגור אותו מטעמי בטיחות.'
      : isReadOnlyMode
        ? 'שרת מנהל הפורטים נמצא במצב "קריאה בלבד". שנה את מצב הבטיחות בהגדרות כדי לאפשר סגירה.'
        : `סגור תהליך PID ${portObj.pid} בפורט ${portObj.port} — דורש הקלדת אישור.`;
  ```

- [ ] **Step 2: Update metrics and filters in `public/app.js`**
  Modify filters and metrics counters to use `portObj.isSystem` instead of `portObj.port <= 1024`.
  
  ```javascript
  // In applyFilters():
  if (activeFilter === 'system' && !portObj.isSystem) return false;
  if (activeFilter === 'user' && portObj.isSystem) return false;
  
  // In updateMetrics():
  const userCount = uniquePorts.filter(p => !p.isSystem).length;
  const systemCount = uniquePorts.filter(p => p.isSystem).length;
  ```

- [ ] **Step 3: Update labels and layout in `public/index.html`**
  Open [public/index.html](file:///Users/yonig/Desktop/projects/ports/public/index.html) and clean up hardcoded port references:
  - Line 58: Update text to explain that system processes are protected instead of "essential system ports (< 1024)".
  - Line 90: Update text to explain "essential system processes" rather than "ports below 1024".
  - Line 108: Update metric card title to `תהליכי משתמש` or `פורטי משתמש`.
  - Line 115: Update metric card title to `תהליכי מערכת` or `פורטי מערכת`.
  - Line 133: Update filter tab to `פורטי משתמש` (User ports).
  - Line 134: Update filter tab to `פורטי מערכת` (System ports).

- [ ] **Step 4: Commit changes**
  Run:
  ```bash
  git add public/app.js public/index.html
  git commit -m "ui: update frontend to use dynamic system process classification"
  ```

---

### Task 6: Final Verification

**Files:**
- None

- [ ] **Step 1: Run the full test suite**
  Run: `npm test`
  Expected: All tests pass successfully (81/81 or more).

- [ ] **Step 2: Commit final status**
  Run:
  ```bash
  git status
  ```
  Expected: Clean working tree.
