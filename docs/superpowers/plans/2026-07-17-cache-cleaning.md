# Cache Cleaning Feature Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a secure, user-friendly macOS Cache Cleaning system with safety classifications and native macOS Trash bin fallback, integrated into the UI and MCP server.

**Architecture:** Extend the existing Express HTTP endpoints and Electron shell integration to support safe scanning of `~/.npm`, `~/Library/Caches`, and local project workspaces, resolving deletions safely via AppleScript/Electron trashing.

**Tech Stack:** Node.js, Express, AppleScript (`osascript`), Electron Shell APIs, HTML/CSS/JavaScript (vanilla).

## Global Constraints
- Target OS: macOS only (uses `lsof`, `ps`, `osascript`, `df`, `du`).
- All interactive UI buttons must satisfy a minimum `44x44px` hit target.
- Deletions must go to the macOS Trash (no direct `rm -rf`).
- Safety rate limiter and mode checks must be enforced for destructive actions.

---

### Task 1: Safety & Validation Layer Updates

**Files:**
- Modify: `src/safety.js`
- Test: `test/safety.test.js`

**Interfaces:**
- Produces: `SafetyLayer.checkCachePath(targetPath)` (returns boolean or throws SafetyError).

- [ ] **Step 1: Add failing test for cache path validation**
  Add to `test/safety.test.js`:
  ```javascript
  test('SafetyLayer.checkCachePath blocks paths outside home or containing invalid segments', async () => {
    const config = createMockConfig({ mode: 'allowlist' });
    const safety = new SafetyLayer({ config, currentUser: 'testuser' });
    
    // Should pass:
    assert.ok(safety.checkCachePath('/Users/testuser/.npm'));
    assert.ok(safety.checkCachePath('/Users/testuser/Library/Caches/foo'));
    
    // Should fail:
    assert.throws(() => safety.checkCachePath('/System/Library/Caches'), /SafetyError/);
    assert.throws(() => safety.checkCachePath('/Users/otheruser/.npm'), /SafetyError/);
    assert.throws(() => safety.checkCachePath('/Users/testuser/.npm/../../critical'), /SafetyError/);
  });
  ```

- [ ] **Step 2: Run test to verify it fails**
  Run: `node --test test/safety.test.js`
  Expected: FAIL (checkCachePath is not a function)

- [ ] **Step 3: Implement `checkCachePath` in `src/safety.js`**
  Add the following inside the `SafetyLayer` class in `src/safety.js`:
  ```javascript
  checkCachePath(targetPath) {
    const path = require('node:path');
    const normalized = path.normalize(targetPath);
    const homeDir = os.homedir();

    if (!normalized.startsWith(homeDir)) {
      throw new SafetyError('PATH_OUTSIDE_HOME', `Path "${normalized}" is outside the user home directory.`);
    }

    if (normalized.includes('..')) {
      throw new SafetyError('PATH_TRAVERSAL', `Path traversal detected in "${normalized}".`);
    }

    const allowedPatterns = [
      /\/\.npm$/,
      /\/Library\/Caches\/.+/,
      /\/\.bun\/install\/cache$/,
      /\/\.next\/cache$/,
      /\/node_modules\/\.cache$/,
      /\/\.vite$/
    ];

    const isMatch = allowedPatterns.some(pattern => pattern.test(normalized));
    if (!isMatch) {
      throw new SafetyError('PATH_NOT_A_CACHE', `Path "${normalized}" is not a recognized or safe cache folder.`);
    }

    return true;
  }
  ```

- [ ] **Step 4: Run test to verify it passes**
  Run: `node --test test/safety.test.js`
  Expected: PASS

- [ ] **Step 5: Commit**
  ```bash
  git add src/safety.js test/safety.test.js
  git commit -m "feat: add cache path validation to safety layer"
  ```

---

### Task 2: Port-Service Cache Scanning & Categorization

**Files:**
- Modify: `src/port-service.js`
- Test: `test/storage-tools.test.js`

**Interfaces:**
- Consumes: `SafetyLayer.checkCachePath(targetPath)`
- Produces: `PortService.getCacheDetails()` (returns array of cache items with sizes and safety classifications).

- [ ] **Step 1: Write test for cache scanning and categorization**
  Modify `test/storage-tools.test.js` to include verification for `getCacheDetails()`:
  ```javascript
  test('getCacheDetails categorizes folders and calculates sizes', async () => {
    const cacheDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ports-mcp-cache-details-'));
    await fs.mkdir(path.join(cacheDir, 'com.apple.Safari'));
    
    const runner = {
      execFile: async (file, args) => {
        if (file === 'du') {
          return { stdout: `1024\t${path.join(cacheDir, 'com.apple.Safari')}\n` };
        }
        return { stdout: '' };
      }
    };
    
    const service = createPortService({ cacheDir, runner });
    const details = await service.getCacheDetails();
    
    const safariItem = details.find(i => i.name === 'com.apple.Safari');
    assert.ok(safariItem);
    assert.equal(safariItem.category, 'NEEDS_CONFIRMATION');
    assert.equal(safariItem.bytes, 1048576); // 1024 KB
    
    await fs.rm(cacheDir, { recursive: true, force: true });
  });
  ```

- [ ] **Step 2: Run test to verify it fails**
  Run: `node --test test/storage-tools.test.js`
  Expected: FAIL (getCacheDetails is not a function)

- [ ] **Step 3: Implement `getCacheDetails` in `src/port-service.js`**
  Add inside `createPortService` factory function in `src/port-service.js`:
  ```javascript
  async function getCacheDetails() {
    const cacheDir = options.cacheDir || path.join(os.homedir(), 'Library', 'Caches');
    const homeDir = os.homedir();
    const globalCaches = [
      { name: 'npm Cache', path: path.join(homeDir, '.npm'), description: 'npm package manager download cache', category: 'SAFE_TO_CLEAR' },
      { name: 'Yarn Cache', path: path.join(cacheDir, 'Yarn'), description: 'Yarn package manager download cache', category: 'SAFE_TO_CLEAR' },
      { name: 'pnpm Cache', path: path.join(cacheDir, 'pnpm'), description: 'pnpm package manager download cache', category: 'SAFE_TO_CLEAR' },
      { name: 'Bun Cache', path: path.join(homeDir, '.bun', 'install', 'cache'), description: 'Bun package installation cache', category: 'SAFE_TO_CLEAR' },
      { name: 'Next.js Cache (.next/cache)', path: path.join(process.cwd(), '.next', 'cache'), description: 'Local Next.js project build cache', category: 'SAFE_TO_CLEAR' },
      { name: 'Vite Cache', path: path.join(process.cwd(), 'node_modules', '.cache'), description: 'Local Vite dependency pre-bundle cache', category: 'SAFE_TO_CLEAR' }
    ];

    let items = [];
    
    // Check global/local specific paths
    for (const item of globalCaches) {
      try {
        const stats = await fs.stat(item.path);
        if (stats.isDirectory()) {
          items.push(item);
        }
      } catch {}
    }

    // Scan general User Caches
    try {
      const entries = await fs.readdir(cacheDir, { withFileTypes: true });
      const systemCaches = entries
        .filter(entry => entry.isDirectory() && !['Yarn', 'pnpm'].includes(entry.name))
        .map(entry => ({
          name: entry.name,
          path: path.join(cacheDir, entry.name),
          description: `macOS User cache folder for ${entry.name}`,
          category: 'NEEDS_CONFIRMATION'
        }))
        .slice(0, 100);
      items.push(...systemCaches);
    } catch {}

    // Calculate sizes using 'du -sk'
    if (items.length > 0) {
      const paths = items.map(i => i.path);
      try {
        const { stdout } = await runner.execFile('du', ['-sk', ...paths], { allowNonZero: true });
        const sizeMap = new Map();
        String(stdout || '').split('\n').forEach(line => {
          const match = line.match(/^(\d+)\s+(.+)$/);
          if (match) {
            sizeMap.set(path.normalize(match[2]), Number(match[1]) * 1024);
          }
        });
        
        items = items.map(item => {
          const normPath = path.normalize(item.path);
          return {
            ...item,
            bytes: sizeMap.get(normPath) || 0
          };
        }).filter(item => item.bytes > 0);
      } catch {}
    }

    return items;
  }
  ```
  Export it in the returned service object:
  ```javascript
  return {
    // ... other methods
    getCacheDetails,
  };
  ```

- [ ] **Step 4: Run test to verify it passes**
  Run: `node --test test/storage-tools.test.js`
  Expected: PASS

- [ ] **Step 5: Commit**
  ```bash
  git add src/port-service.js test/storage-tools.test.js
  git commit -m "feat: add getCacheDetails cache scanning to port-service"
  ```

---

### Task 3: Port-Service Cache Deletion/Trashing via AppleScript & Electron

**Files:**
- Modify: `src/port-service.js`
- Test: `test/storage-tools.test.js`

**Interfaces:**
- Consumes: `SafetyLayer.checkCachePath(targetPath)`
- Produces: `PortService.trashCachePath({ path, confirm })` (moves folder to macOS Trash, returns boolean).

- [ ] **Step 1: Write test for trashing action**
  Add test to `test/storage-tools.test.js`:
  ```javascript
  test('trashCachePath executes osascript Finder delete when confirm is true', async () => {
    let ranAppleScript = false;
    const runner = {
      execFile: async (file, args) => {
        if (file === 'osascript') {
          assert.ok(args[1].includes('delete POSIX file'));
          ranAppleScript = true;
          return { stdout: '' };
        }
        return { stdout: '' };
      }
    };
    
    const service = createPortService({ runner });
    const result = await service.trashCachePath({
      path: path.join(os.homedir(), '.npm'),
      confirm: true
    });
    
    assert.deepEqual(result, { ok: true, trashed: true });
    assert.ok(ranAppleScript);
  });
  ```

- [ ] **Step 2: Run test to verify it fails**
  Run: `node --test test/storage-tools.test.js`
  Expected: FAIL (trashCachePath is not a function)

- [ ] **Step 3: Implement `trashCachePath` in `src/port-service.js`**
  Add inside `createPortService` factory function:
  ```javascript
  async function trashCachePath({ path: targetPath, confirm = false }) {
    safetyLayer.checkCachePath(targetPath);

    if (confirm !== true) {
      return { dryRun: true, wouldTrash: targetPath };
    }

    // Attempt Electron native trashing if running in Electron environment
    try {
      const { shell } = require('electron');
      if (shell && typeof shell.trashItem === 'function') {
        await shell.trashItem(targetPath);
        return { ok: true, trashed: true, path: targetPath };
      }
    } catch {}

    // Fallback to AppleScript for CLI / Web Server mode
    const escapedPath = targetPath.replace(/(["\\])/g, '\\$1');
    const appleScript = `tell application "Finder" to delete POSIX file "${escapedPath}"`;
    
    await runner.execFile('osascript', ['-e', appleScript]);
    return { ok: true, trashed: true, path: targetPath };
  }
  ```
  And export it in the service return object.

- [ ] **Step 4: Run test to verify it passes**
  Run: `node --test test/storage-tools.test.js`
  Expected: PASS

- [ ] **Step 5: Commit**
  ```bash
  git add src/port-service.js test/storage-tools.test.js
  git commit -m "feat: add trashCachePath implementation to port-service"
  ```

---

### Task 4: HTTP API Endpoints for Cache

**Files:**
- Modify: `src/http-server.js`
- Test: `test/system-routes.test.js`

- [ ] **Step 1: Write routes test verification**
  Add to `test/system-routes.test.js`:
  ```javascript
  test('GET /api/system/cache returns cache array', async () => {
    // mock http server test calls
  });
  ```

- [ ] **Step 2: Add express handlers in `src/http-server.js`**
  Add these routes:
  ```javascript
  app.get('/api/system/cache', async (_req, res) => {
    try {
      const caches = await service.getCacheDetails();
      res.json({ items: caches });
    } catch (error) {
      sendError(res, error);
    }
  });

  app.post('/api/system/cache/trash', async (req, res) => {
    try {
      const body = req.body || {};
      const result = await service.trashCachePath({
        path: body.path,
        confirm: body.confirm
      });
      res.json(result);
    } catch (error) {
      sendError(res, error);
    }
  });
  ```

- [ ] **Step 3: Run the test suite and verify everything builds**
  Run: `npm test`
  Expected: All tests pass.

- [ ] **Step 4: Commit**
  ```bash
  git add src/http-server.js test/system-routes.test.js
  git commit -m "feat: add Express routes for cache scanning and trashing"
  ```

---

### Task 5: MCP Tools Integration

**Files:**
- Modify: `src/mcp-server.js`, `src/mcp-tools.js`
- Test: `test/tools.test.js`

- [ ] **Step 1: Register tools metadata in `src/mcp-tools.js`**
  Append these tool schemas to `MCP_TOOL_SCHEMAS`:
  ```javascript
  list_caches: {
    name: "list_caches",
    description: "Scan and list macOS user and developer cache folders, size in bytes, and safety category.",
    inputSchema: { type: "object", properties: {} }
  },
  clean_cache: {
    name: "clean_cache",
    description: "Move a specific cache directory to the system trash bin safely.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Absolute path to the cache directory" },
        confirm: { type: "boolean", description: "Must be true to perform the trashing action" }
      },
      required: ["path", "confirm"]
    }
  }
  ```

- [ ] **Step 2: Bind handler logic in `src/mcp-server.js`**
  Inside `server.setRequestHandler(CallToolRequestSchema)`:
  ```javascript
  case 'list_caches': {
    const items = await service.getCacheDetails();
    return {
      content: [{ type: 'text', text: JSON.stringify(items, null, 2) }]
    };
  }
  case 'clean_cache': {
    const { path: targetPath, confirm } = request.params.arguments;
    const result = await service.trashCachePath({ path: targetPath, confirm });
    return {
      content: [{ type: 'text', text: JSON.stringify(result, null, 2) }]
    };
  }
  ```

- [ ] **Step 3: Run full tests to verify MCP tools**
  Run: `npm test`
  Expected: PASS

- [ ] **Step 4: Commit**
  ```bash
  git add src/mcp-server.js src/mcp-tools.js
  git commit -m "feat: implement list_caches and clean_cache MCP tools"
  ```

---

### Task 6: UI Styling and Layout Upgrades

**Files:**
- Modify: `public/index.html`
- Modify: `public/style.css`

- [ ] **Step 1: Update Storage Card Markup in `public/index.html`**
  Replace `#cache-findings` wrapper with:
  ```html
  <div class="cache-control-header">
    <button id="quick-clean-cache-btn" class="btn btn-success hidden" type="button">
      <svg class="icon-svg" viewBox="0 0 24 24" width="16" height="16" stroke="currentColor" stroke-width="2" fill="none"><path d="M12 2v20M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/></svg>
      ניקוי קבצי פיתוח זמניים
    </button>
  </div>
  <div id="cache-findings" class="storage-findings-grid" aria-live="polite">
    <!-- Skeleton loader goes here during load -->
  </div>
  ```

- [ ] **Step 2: Add CSS rules for cache components to `public/style.css`**
  Add styles for the grid, safety badges, and interactive trash/lock buttons:
  ```css
  .cache-control-header {
    display: flex;
    justify-content: flex-end;
    margin-bottom: 12px;
  }
  .storage-findings-grid {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .cache-item-row {
    display: flex;
    justify-content: space-between;
    align-items: center;
    background: rgba(255, 255, 255, 0.03);
    border: 1px solid var(--border-color);
    padding: 12px 16px;
    border-radius: var(--radius-md);
    transition: var(--transition-fast);
  }
  .cache-item-row:hover {
    background: var(--bg-card-hover);
    transform: translateY(-1px);
  }
  .cache-badge {
    padding: 2px 8px;
    border-radius: 9999px;
    font-size: 0.75rem;
    font-weight: 600;
  }
  .cache-badge-safe {
    background: rgba(16, 185, 129, 0.1);
    color: var(--color-success);
  }
  .cache-badge-caution {
    background: rgba(245, 158, 11, 0.1);
    color: var(--color-warning);
  }
  .btn-trash-action {
    background: transparent;
    border: none;
    cursor: pointer;
    color: var(--text-secondary);
    padding: 8px;
    border-radius: var(--radius-sm);
    min-width: 44px;
    min-height: 44px;
    display: flex;
    align-items: center;
    justify-content: center;
    transition: var(--transition-fast);
  }
  .btn-trash-action:hover {
    color: var(--color-danger);
    background: rgba(239, 68, 68, 0.1);
  }
  .btn-trash-action:disabled {
    color: var(--text-muted);
    cursor: not-allowed;
  }
  ```

- [ ] **Step 3: Commit UI enhancements**
  ```bash
  git add public/index.html public/style.css
  git commit -m "style: upgrade cache scanning UI layout and styles"
  ```

---

### Task 7: Frontend JavaScript Deletion Logic & Confirm Modal

**Files:**
- Modify: `public/app.js`

- [ ] **Step 1: Update `updateStorageUsage` in `public/app.js`**
  Modify file scanning logic to consume new API `/api/system/cache` instead of general disk usage logic, formatting rows with SVG actions, safety badges, and click bindings.
  Implement the Quick Clean click listener to trash all `SAFE_TO_CLEAR` items.
  Implement the Confirmation Modal prompt prior to trashing.

- [ ] **Step 2: Commit Frontend JS changes**
  ```bash
  git add public/app.js
  git commit -m "feat: complete UI interaction logic for cache cleaning"
  ```

---

## Verification Plan

### Automated Verification
Run: `npm test`
Verify that all unit tests pass, and test coverage is preserved.

### Manual Verification
Run the dev server: `npm run dev`
1. Navigate to `http://127.0.0.1:9999`.
2. Inspect the "Storage and Temporary Files" panel.
3. Verify that the Skeleton loader is displayed.
4. Verify that global cache folders (like `.npm`) are listed with Green badges.
5. Click the Trash icon next to `.npm` - verify that a warning modal is shown.
6. Click "Confirm" - verify that `.npm` is removed from the list and is sent to macOS Trash (Finder verification).
7. Test the "Quick Clean" button - verify all safe caches are trashed together.
