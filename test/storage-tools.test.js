const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createPortService } = require('../src/port-service');
const { SafetyConfig } = require('../src/config');
const { SafetyLayer } = require('../src/safety');

test('getStorageUsage reports disk capacity and largest readable cache folders', async () => {
  const baseDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ports-mcp-storage-'));
  const homeDir = path.join(baseDir, 'home');
  const cwd = path.join(baseDir, 'cwd');
  const cacheDir = path.join(homeDir, 'Library', 'Caches');

  await fs.mkdir(homeDir, { recursive: true });
  await fs.mkdir(cwd, { recursive: true });
  await fs.mkdir(cacheDir, { recursive: true });

  await fs.mkdir(path.join(cacheDir, 'small'));
  await fs.mkdir(path.join(cacheDir, 'large'));

  const runner = {
    execFile: async (file, args) => {
      if (file === 'df') {
        assert.deepEqual(args, ['-kP', '/']);
        return { stdout: 'Filesystem 1024-blocks Used Available Capacity Mounted on\n/dev/disk3 1000 400 600 40% /\n' };
      }
      if (file === 'du') {
        assert.deepEqual(args, ['-sk', path.join(cacheDir, 'large'), path.join(cacheDir, 'small')]);
        return { stdout: `2048\t${path.join(cacheDir, 'large')}\n512\t${path.join(cacheDir, 'small')}\n` };
      }
      throw new Error(`unexpected command: ${file}`);
    }
  };

  try {
    const usage = await createPortService({ homeDir, cwd, cacheDir, runner }).getStorageUsage();
    assert.deepEqual(usage.disk, { totalBytes: 1024000, usedBytes: 409600, availableBytes: 614400, percentage: 40 });
    assert.deepEqual(usage.cache.items, [
      { name: 'large', path: path.join(cacheDir, 'large'), bytes: 2097152 },
      { name: 'small', path: path.join(cacheDir, 'small'), bytes: 524288 }
    ]);
    assert.equal(usage.cache.knownBytes, 2621440);
    assert.equal(usage.cache.scannedItems, 2);
  } finally {
    await fs.rm(baseDir, { recursive: true, force: true });
  }
});

test('getCacheDetails categorizes folders and calculates sizes with mocked homeDir and cwd', async () => {
  const baseDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ports-mcp-cache-details-'));
  const homeDir = path.join(baseDir, 'home');
  const cwd = path.join(baseDir, 'cwd');
  const cacheDir = path.join(homeDir, 'Library', 'Caches');

  await fs.mkdir(homeDir, { recursive: true });
  await fs.mkdir(cwd, { recursive: true });
  await fs.mkdir(cacheDir, { recursive: true });

  // Create simulated directories
  await fs.mkdir(path.join(homeDir, '.npm'), { recursive: true });
  await fs.mkdir(path.join(homeDir, '.bun', 'install', 'cache'), { recursive: true });
  await fs.mkdir(path.join(cacheDir, 'com.apple.Safari'), { recursive: true });
  await fs.mkdir(path.join(cacheDir, 'Yarn'), { recursive: true });
  await fs.mkdir(path.join(cwd, '.next', 'cache'), { recursive: true });
  await fs.mkdir(path.join(cwd, 'node_modules', '.cache'), { recursive: true });

  const runner = {
    execFile: async (file, args) => {
      if (file === 'du') {
        const lines = args.slice(1).map((p, idx) => `${(idx + 1) * 1024}\t${p}`);
        return { stdout: lines.join('\n') + '\n' };
      }
      return { stdout: '' };
    }
  };

  try {
    const service = createPortService({ homeDir, cwd, cacheDir, runner });
    const details = await service.getCacheDetails();

    const npmItem = details.find(i => i.name === 'npm Cache');
    assert.ok(npmItem);
    assert.equal(npmItem.category, 'SAFE_TO_CLEAR');
    assert.ok(npmItem.bytes > 0);

    const safariItem = details.find(i => i.name === 'com.apple.Safari');
    assert.ok(safariItem);
    assert.equal(safariItem.category, 'NEEDS_CONFIRMATION');
    assert.ok(safariItem.bytes > 0);

    const yarnItem = details.find(i => i.name === 'Yarn Cache');
    assert.ok(yarnItem);
    assert.equal(yarnItem.category, 'SAFE_TO_CLEAR');
    assert.ok(yarnItem.bytes > 0);

    const nextItem = details.find(i => i.name === 'Next.js Cache (.next/cache)');
    assert.ok(nextItem);
    assert.equal(nextItem.category, 'SAFE_TO_CLEAR');
    assert.ok(nextItem.bytes > 0);
  } finally {
    await fs.rm(baseDir, { recursive: true, force: true });
  }
});

test('getCacheDetails invokes safetyLayer.checkCachePath and filters out blocked paths', async () => {
  const baseDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ports-mcp-cache-safety-'));
  const homeDir = path.join(baseDir, 'home');
  const cwd = path.join(baseDir, 'cwd');
  const cacheDir = path.join(homeDir, 'Library', 'Caches');

  await fs.mkdir(homeDir, { recursive: true });
  await fs.mkdir(cwd, { recursive: true });
  await fs.mkdir(cacheDir, { recursive: true });

  await fs.mkdir(path.join(homeDir, '.npm'), { recursive: true });
  await fs.mkdir(path.join(cacheDir, 'badFolder'), { recursive: true });

  const runner = {
    execFile: async (file, args) => {
      if (file === 'du') {
        const lines = args.slice(1).map((p, idx) => `${(idx + 1) * 1024}\t${p}`);
        return { stdout: lines.join('\n') + '\n' };
      }
      return { stdout: '' };
    }
  };

  const safetyLayer = {
    checkCachePath: async (p) => {
      if (p.includes('badFolder')) {
        throw new Error('SafetyError: blocked path');
      }
    }
  };

  try {
    const service = createPortService({ homeDir, cwd, cacheDir, runner, safetyLayer });
    const details = await service.getCacheDetails();

    const npmItem = details.find(i => i.name === 'npm Cache');
    assert.ok(npmItem);

    const badItem = details.find(i => i.name === 'badFolder');
    assert.equal(badItem, undefined);
  } finally {
    await fs.rm(baseDir, { recursive: true, force: true });
  }
});

test('getCacheDetails returns items with bytes: 0 when du command fails', async () => {
  const baseDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ports-mcp-cache-du-fail-'));
  const homeDir = path.join(baseDir, 'home');
  const cwd = path.join(baseDir, 'cwd');
  const cacheDir = path.join(homeDir, 'Library', 'Caches');

  await fs.mkdir(homeDir, { recursive: true });
  await fs.mkdir(cwd, { recursive: true });
  await fs.mkdir(cacheDir, { recursive: true });

  await fs.mkdir(path.join(homeDir, '.npm'), { recursive: true });

  const runner = {
    execFile: async (file, args) => {
      if (file === 'du') {
        throw new Error('du command failed');
      }
      return { stdout: '' };
    }
  };

  try {
    const service = createPortService({ homeDir, cwd, cacheDir, runner });
    const details = await service.getCacheDetails();

    const npmItem = details.find(i => i.name === 'npm Cache');
    assert.ok(npmItem);
    assert.equal(npmItem.bytes, 0);
  } finally {
    await fs.rm(baseDir, { recursive: true, force: true });
  }
});

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
  
  const targetPath = path.join(os.homedir(), '.npm');
  const service = createPortService({ runner });
  const result = await service.trashCachePath({
    path: targetPath,
    confirm: true
  });
  
  assert.deepEqual(result, { ok: true, trashed: true, path: targetPath });
  assert.ok(ranAppleScript);
});

test('trashCachePath returns dryRun object when confirm is false', async () => {
  const runner = {
    execFile: async () => {
      throw new Error('should not execute shell commands on dry run');
    }
  };
  
  const targetPath = path.join(os.homedir(), '.npm');
  const service = createPortService({ runner });
  const result = await service.trashCachePath({
    path: targetPath,
    confirm: false
  });
  
  assert.deepEqual(result, { dryRun: true, wouldTrash: targetPath });
});

test('trashCachePath throws PortManagerError (403 status) when path validation fails (path outside home)', async () => {
  const safetyConfig = new SafetyConfig({ mode: 'blocklist' });
  const safetyLayer = new SafetyLayer({ config: safetyConfig, currentUser: 'yoni' });
  const service = createPortService({ safetyLayer });
  const targetPath = '/System/Library/Caches';

  await assert.rejects(
    async () => {
      await service.trashCachePath({ path: targetPath, confirm: true });
    },
    (err) => {
      assert.ok(err instanceof Error);
      assert.equal(err.name, 'PortManagerError');
      assert.equal(err.status, 403);
      assert.equal(err.code, 'PATH_OUTSIDE_HOME');
      return true;
    }
  );
});

test('trashCachePath throws PortManagerError (403 status) when safety layer check fails (e.g. read-only mode)', async () => {
  const safetyConfig = new SafetyConfig({ mode: 'read-only' });
  const safetyLayer = new SafetyLayer({ config: safetyConfig, currentUser: 'yoni' });
  const service = createPortService({ safetyLayer });
  const targetPath = path.join(os.homedir(), 'Library', 'Caches', 'npm');

  await assert.rejects(
    async () => {
      await service.trashCachePath({ path: targetPath, confirm: true });
    },
    (err) => {
      assert.ok(err instanceof Error);
      assert.equal(err.name, 'PortManagerError');
      assert.equal(err.status, 403);
      assert.equal(err.code, 'SAFETY_MODE');
      assert.match(err.message, /read-only/);
      return true;
    }
  );
});


