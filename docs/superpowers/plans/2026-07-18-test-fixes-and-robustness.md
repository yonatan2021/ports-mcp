# Test Fixes and Robustness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the two failing tests (`test/port-service.test.js` mock mismatch and `test/storage-tools.test.js` du failing error swallowing) and create a comprehensive integration and robustness test suite (`test/comprehensive-robustness.test.js`) to prevent silent failures.

**Architecture:** 
1. Generalize the lsof mock in `port-service.test.js` to match comma-joined list of PIDs.
2. Propagate errors from `getSizesForPaths` in `port-service.js` instead of swallowing them inside the function, enabling `getCacheDetails` to fall back to listing caches with size 0 instead of filtering them out when size calculation fails.
3. Write a brand new robustness test file (`test/comprehensive-robustness.test.js`) containing integration tests for command failure recovery, API parameter validation, safety/mode boundary checks, and rate-limiting limits.

**Tech Stack:** Node.js, Express, node:test framework.

## Global Constraints
- Node version >= 18.0.0.
- All testing runs with `BypassSandbox: true` (due to local TCP port binding and system calls like `lsof` / `ps`).
- Always run tests using `node --test` command.
- Keep responses clean and errors formatted with `safe_hint`.

---

### Task 1: Fix `test/port-service.test.js` Mock

**Files:**
- Modify: `test/port-service.test.js`

**Interfaces:**
- Consumes: `createPortService` from `src/port-service.js`.
- Produces: None.

- [ ] **Step 1: Write the failing test state description**
  Observe the failure in the `listPorts uses execFile argv and enriches command lines without shell interpolation` test. The mock is checking:
  ```javascript
  if (args[2] === '12345') return { stdout: 'p12345\nfcwd\nn/Users/yoni/projects/api\n', stderr: '', exitCode: 0 };
  ```
  But the actual arguments passed are `['-a', '-p', '12345,22222,33333', '-d', 'cwd', '-Fn']`. Therefore `args[2]` is `'12345,22222,33333'`, causing it to return empty string and `workingDirectory` to be `null` instead of `'/Users/yoni/projects/api'`.

- [ ] **Step 2: Run test to verify it fails**
  Run: `node --test test/port-service.test.js`
  Expected:
  ```
  not ok 24 - listPorts uses execFile argv and enriches command lines without shell interpolation
    ---
    code: 'ERR_ASSERTION'
    expected: '/Users/yoni/projects/api'
    actual: null
  ```

- [ ] **Step 3: Modify the mock in `test/port-service.test.js`**
  Modify line 56 of [test/port-service.test.js](file:///Users/yonig/Desktop/projects/ports/test/port-service.test.js):
  From:
  ```javascript
        if (args[2] === '12345') return { stdout: 'p12345\nfcwd\nn/Users/yoni/projects/api\n', stderr: '', exitCode: 0 };
  ```
  To:
  ```javascript
        if (args[2] && args[2].split(',').includes('12345')) return { stdout: 'p12345\nfcwd\nn/Users/yoni/projects/api\n', stderr: '', exitCode: 0 };
  ```

- [ ] **Step 4: Run test to verify it passes**
  Run: `node --test test/port-service.test.js` (Note: Run with BypassSandbox: true if executing via run_command tool)
  Expected: PASS

- [ ] **Step 5: Commit**
  Run:
  ```bash
  git add test/port-service.test.js
  git commit -m "fix(test): handle batch PIDs in lsof workingDirectory mock"
  ```

---

### Task 2: Fix Error Propagation in `src/port-service.js`

**Files:**
- Modify: `src/port-service.js`

**Interfaces:**
- Consumes: `getSizesForPaths` inside `src/port-service.js`.
- Produces: `getCacheDetails()` returns items with size 0 instead of filtering them out when size calculation fails.

- [ ] **Step 1: Locate and inspect the failing test in `test/storage-tools.test.js`**
  Observe the failure in the test:
  `getCacheDetails returns items with bytes: 0 when du command fails`
  The mock runner throws for `du`, and because `getSizesForPaths` catches it internally and returns `results` with `{ [path]: 0 }`, the `try` block in `getCacheDetails` succeeds and then filters out empty items with `bytes > 0`, causing the items to be completely omitted.

- [ ] **Step 2: Run test to verify it fails**
  Run: `node --test test/storage-tools.test.js`
  Expected:
  ```
  not ok 85 - getCacheDetails returns items with bytes: 0 when du command fails
    ---
    failureType: 'testCodeFailure'
    error: 'The expression evaluated to a falsy value: assert.ok(npmItem)'
  ```

- [ ] **Step 3: Modify `getSizesForPaths` in `src/port-service.js`**
  Modify [src/port-service.js](file:///Users/yonig/Desktop/projects/ports/src/port-service.js):
  Remove the internal `try-catch` inside `getSizesForPaths` (lines 196-201) so that the execution error is propagated to the caller.
  Specifically, change the implementation of `getSizesForPaths` starting from line 166:
  From:
  ```javascript
    async function getSizesForPaths(paths) {
      const normPaths = paths.map(p => path.normalize(p));
      const missingPaths = [];
      const results = {};
  
      for (const p of normPaths) {
        const cached = sizeCache.get(p);
        if (cached !== null) {
          results[p] = cached;
        } else {
          missingPaths.push(p);
        }
      }
  
      if (missingPaths.length > 0) {
        try {
          const { stdout } = await runner.execFile('du', ['-sk', ...missingPaths], { allowNonZero: true });
          const sizeMap = new Map();
          String(stdout || '').split('\n').forEach(line => {
            const match = line.match(/^(\d+)\s+(.+)$/);
            if (match) {
              sizeMap.set(path.normalize(match[2]), Number(match[1]) * 1024);
            }
          });
  
          for (const p of missingPaths) {
            const bytes = sizeMap.get(p) || 0;
            sizeCache.set(p, bytes);
            results[p] = bytes;
          }
        } catch (err) {
          for (const p of missingPaths) {
            sizeCache.set(p, 0);
            results[p] = 0;
          }
        }
      }
  
      return results;
    }
  ```
  To:
  ```javascript
    async function getSizesForPaths(paths) {
      const normPaths = paths.map(p => path.normalize(p));
      const missingPaths = [];
      const results = {};
  
      for (const p of normPaths) {
        const cached = sizeCache.get(p);
        if (cached !== null) {
          results[p] = cached;
        } else {
          missingPaths.push(p);
        }
      }
  
      if (missingPaths.length > 0) {
        const { stdout } = await runner.execFile('du', ['-sk', ...missingPaths], { allowNonZero: true });
        const sizeMap = new Map();
        String(stdout || '').split('\n').forEach(line => {
          const match = line.match(/^(\d+)\s+(.+)$/);
          if (match) {
            sizeMap.set(path.normalize(match[2]), Number(match[1]) * 1024);
          }
        });
  
        for (const p of missingPaths) {
          const bytes = sizeMap.get(p) || 0;
          sizeCache.set(p, bytes);
          results[p] = bytes;
        }
      }
  
      return results;
    }
  ```

- [ ] **Step 4: Run test to verify it passes**
  Run: `node --test test/storage-tools.test.js` (Note: Run with BypassSandbox: true if executing via run_command tool)
  Expected: PASS

- [ ] **Step 5: Commit**
  Run:
  ```bash
  git add src/port-service.js
  git commit -m "fix(service): propagate du error from getSizesForPaths to preserve cache list"
  ```

---

### Task 3: Create Comprehensive Robustness Test Suite

**Files:**
- Create: `test/comprehensive-robustness.test.js`

**Interfaces:**
- Consumes: `createPortService` from `src/port-service.js`, `createApp` from `src/http-server.js`, `createSafetyLayer` from `src/safety.js`.
- Produces: None.

- [ ] **Step 1: Write `test/comprehensive-robustness.test.js`**
  Create [test/comprehensive-robustness.test.js](file:///Users/yonig/Desktop/projects/ports/test/comprehensive-robustness.test.js) with the following complete code content:
  ```javascript
  const test = require('node:test');
  const assert = require('node:assert/strict');
  const http = require('node:http');
  const path = require('node:path');
  const fs = require('node:fs/promises');
  const os = require('node:os');
  const { createApp } = require('../src/http-server');
  const { createPortService } = require('../src/port-service');
  const { SafetyLayer } = require('../src/safety');
  const { createConfig } = require('../src/config');
  
  // 1. Resiliency on system command failures
  test('listPorts gracefully degrades when lsof fails completely', async () => {
    const runner = {
      execFile: async () => {
        throw new Error('lsof failed to execute');
      }
    };
    const service = createPortService({ runner });
    const ports = await service.listPorts();
    assert.deepEqual(ports, []);
  });
  
  test('listPorts gracefully degrades when ps fails completely', async () => {
    const runner = {
      execFile: async (file, args) => {
        if (file === 'lsof') {
          return { stdout: 'p12345\ncnode\nuusername\ntIPv4\nPtcp\n*:3000\n', stderr: '', exitCode: 0 };
        }
        throw new Error('ps failed to execute');
      }
    };
    const service = createPortService({ runner });
    const ports = await service.listPorts();
    assert.equal(ports.length, 1);
    assert.equal(ports[0].pid, 12345);
    assert.equal(ports[0].commandLine, 'Unknown command');
  });
  
  // 2. HTTP API boundary validation checks
  test('HTTP API rejects invalid port arguments with structured error', async () => {
    const app = createApp({ service: {} });
    const server = http.createServer(app);
    await new Promise(r => server.listen(0, '127.0.0.1', r));
    const address = server.address();
    
    try {
      // Test invalid port string
      const res1 = await fetch(`http://127.0.0.1:${address.port}/api/ports/abc`);
      assert.equal(res1.status, 400);
      const errBody1 = await res1.json();
      assert.equal(errBody1.error.code, 'INVALID_PORT');
      
      // Test out of bounds port
      const res2 = await fetch(`http://127.0.0.1:${address.port}/api/ports/99999`);
      assert.equal(res2.status, 400);
      const errBody2 = await res2.json();
      assert.equal(errBody2.error.code, 'INVALID_PORT');
    } finally {
      await new Promise(r => server.close(r));
    }
  });
  
  test('HTTP API POST /api/ports/kill rejects invalid PID with 400', async () => {
    const app = createApp({ service: {} });
    const server = http.createServer(app);
    await new Promise(r => server.listen(0, '127.0.0.1', r));
    const address = server.address();
    
    try {
      const res = await fetch(`http://127.0.0.1:${address.port}/api/ports/kill`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ port: 3000, pid: -5 })
      });
      assert.equal(res.status, 400);
      const errBody = await res.json();
      assert.equal(errBody.error.code, 'INVALID_PID');
    } finally {
      await new Promise(r => server.close(r));
    }
  });
  
  // 3. Safety mode state changes & blocklist validation
  test('Safety settings blocklist prevents port kill actions', async () => {
    const baseDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ports-mcp-robust-config-'));
    const configPath = path.join(baseDir, 'config.json');
    
    try {
      const config = createConfig({ configPath });
      config.setMode('blocklist');
      config.addToBlocklist(8080);
      
      const safetyLayer = new SafetyLayer({ config });
      
      const runner = {
        execFile: async () => ({ stdout: '' })
      };
      
      const service = createPortService({
        runner,
        safetyLayer,
        listPorts: async () => [{ port: 8080, pid: 9876, processName: 'node', user: 'yoni', type: 'IPv4', protocol: 'TCP', address: '*:8080', commandLine: 'node app.js' }]
      });
      
      await assert.rejects(
        async () => {
          await service.killProcessOnPort({ port: 8080, pid: 9876, confirm: true });
        },
        (err) => {
          assert.equal(err.code, 'PORT_BLOCKED');
          assert.equal(err.status, 403);
          return true;
        }
      );
    } finally {
      await fs.rm(baseDir, { recursive: true, force: true });
    }
  });
  
  // 4. Rate limiting alerts on status
  test('Safety layer warns when rate limit capacity is highly loaded', () => {
    const baseDir = path.join(os.tmpdir(), `ports-mcp-rl-${Date.now()}`);
    const config = createConfig({ configPath: path.join(baseDir, 'config.json') });
    config.setMode('allowlist');
    
    const safetyLayer = new SafetyLayer({ config });
    // Artificially trigger rate limiter operations close to the limit
    // Allowlist mode rate limit defaults to 30 per minute
    for (let i = 0; i < 28; i++) {
      safetyLayer._rateLimiter.record();
    }
    
    const status = safetyLayer.getStatus();
    assert.equal(status.rateLimit.activeOpsInWindow, 28);
    assert.ok(status.warnings.some(w => w.includes('approaching')));
  });
  ```

- [ ] **Step 2: Run tests to verify the robustness suite passes**
  Run: `node --test test/comprehensive-robustness.test.js` (Note: Run with BypassSandbox: true if executing via run_command tool)
  Expected: PASS (all tests ok)

- [ ] **Step 3: Commit the new test file**
  Run:
  ```bash
  git add test/comprehensive-robustness.test.js
  git commit -m "test: add comprehensive robustness and safety integration tests"
  ```
