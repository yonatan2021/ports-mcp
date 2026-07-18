const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createPortService } = require('../src/port-service');
const { SafetyConfig } = require('../src/config');
const { SafetyLayer } = require('../src/safety');

test('getDiskUsage reads only df and returns disk capacity', async () => {
  const runner = {
    execFile: async (file, args) => {
      assert.equal(file, 'df');
      assert.deepEqual(args, ['-kP', '/']);
      return { stdout: 'Filesystem 1024-blocks Used Available Capacity Mounted on\n/dev/disk3 1000 400 600 40% /\n' };
    }
  };

  const disk = await createPortService({ runner }).getDiskUsage();

  assert.deepEqual(disk, { totalBytes: 1024000, usedBytes: 409600, availableBytes: 614400, percentage: 40 });
});

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
  await fs.mkdir(path.join(homeDir, '.npm', '_cacache'), { recursive: true });
  await fs.mkdir(path.join(homeDir, '.bun', 'install', 'cache'), { recursive: true });
  await fs.mkdir(path.join(cacheDir, 'com.apple.Safari'), { recursive: true });
  await fs.mkdir(path.join(cacheDir, 'Yarn'), { recursive: true });
  await fs.mkdir(path.join(cwd, '.next', 'cache'), { recursive: true });
  await fs.mkdir(path.join(cwd, 'node_modules', '.cache'), { recursive: true });
  await fs.mkdir(path.join(homeDir, '.gradle', 'caches'), { recursive: true });
  await fs.mkdir(path.join(homeDir, '.cargo', 'registry'), { recursive: true });
  await fs.mkdir(path.join(homeDir, '.cargo', 'git'), { recursive: true });
  await fs.mkdir(path.join(cacheDir, 'CocoaPods'), { recursive: true });

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
    assert.equal(safariItem.category, 'SYSTEM_PROTECTED');
    assert.equal(safariItem.protectedGroup, 'apple-user');
    assert.ok(safariItem.bytes > 0);

    const yarnItem = details.find(i => i.name === 'Yarn Cache');
    assert.ok(yarnItem);
    assert.equal(yarnItem.category, 'SAFE_TO_CLEAR');
    assert.ok(yarnItem.bytes > 0);

    const nextItem = details.find(i => i.name === 'Next.js Cache (.next/cache)');
    assert.ok(nextItem);
    assert.equal(nextItem.category, 'SAFE_TO_CLEAR');
    assert.ok(nextItem.bytes > 0);

    const gradleItem = details.find(i => i.name === 'Gradle Cache');
    assert.ok(gradleItem);
    assert.equal(gradleItem.category, 'SAFE_TO_CLEAR');
    assert.ok(gradleItem.bytes > 0);

    const cargoRegItem = details.find(i => i.name === 'Cargo Registry Cache');
    assert.ok(cargoRegItem);
    assert.equal(cargoRegItem.category, 'SAFE_TO_CLEAR');
    assert.ok(cargoRegItem.bytes > 0);

    const cargoGitItem = details.find(i => i.name === 'Cargo Git Cache');
    assert.ok(cargoGitItem);
    assert.equal(cargoGitItem.category, 'SAFE_TO_CLEAR');
    assert.ok(cargoGitItem.bytes > 0);

    const cocoapodsItem = details.find(i => i.name === 'CocoaPods Cache');
    assert.ok(cocoapodsItem);
    assert.equal(cocoapodsItem.category, 'SAFE_TO_CLEAR');
    assert.ok(cocoapodsItem.bytes > 0);
  } finally {
    await fs.rm(baseDir, { recursive: true, force: true });
  }
});

test('getCacheDetails exposes protected cache roots as read-only grouped records', async () => {
  const baseDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ports-mcp-protected-cache-details-'));
  const homeDir = path.join(baseDir, 'home');
  const cacheDir = path.join(homeDir, 'Library', 'Caches');
  const sharedCacheDir = path.join(baseDir, 'Library', 'Caches');
  const systemCacheDir = path.join(baseDir, 'System', 'Library', 'Caches');

  await fs.mkdir(path.join(cacheDir, 'com.apple.Safari'), { recursive: true });
  await fs.mkdir(path.join(cacheDir, 'com.example.user-app'), { recursive: true });
  await fs.mkdir(path.join(sharedCacheDir, 'com.example.shared'), { recursive: true });
  await fs.mkdir(path.join(systemCacheDir, 'com.apple.core'), { recursive: true });

  const runner = {
    execFile: async (file, args) => {
      if (file === 'du') {
        return { stdout: args.slice(1).map((target, index) => `${index + 1}\t${target}`).join('\n') + '\n' };
      }
      return { stdout: '' };
    }
  };

  try {
    const details = await createPortService({ homeDir, cacheDir, sharedCacheDir, systemCacheDir, runner }).getCacheDetails();
    assert.deepEqual(
      details.filter(item => item.category === 'SYSTEM_PROTECTED').map(({ name, protectedGroup }) => ({ name, protectedGroup })),
      [
        { name: 'com.apple.Safari', protectedGroup: 'apple-user' },
        { name: 'com.example.shared', protectedGroup: 'shared-system' },
        { name: 'com.apple.core', protectedGroup: 'macos-system' }
      ]
    );
    assert.equal(details.find(item => item.name === 'com.example.user-app').category, 'NEEDS_CONFIRMATION');
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

  await fs.mkdir(path.join(homeDir, '.npm', '_cacache'), { recursive: true });
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

  await fs.mkdir(path.join(homeDir, '.npm', '_cacache'), { recursive: true });

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
  
  const mockHome = '/Users/nonexistent-test-user-home';
  const targetPath = path.join(mockHome, '.npm', '_cacache');
  const service = createPortService({ runner, homeDir: mockHome });
  const result = await service.trashCachePath({
    path: targetPath,
    confirm: true
  });
  
  assert.deepEqual(result, { ok: true, trashed: true, path: targetPath });
  assert.ok(ranAppleScript);
});

test('trashCachePath returns dryRun object when confirm is false', async () => {
  const runner = {
    execFile: async (file) => {
      if (file === 'lsof') return { stdout: '' };
      throw new Error('should not execute shell commands on dry run');
    }
  };
  
  const mockHome = '/Users/nonexistent-test-user-home';
  const targetPath = path.join(mockHome, '.npm', '_cacache');
  const service = createPortService({ runner, homeDir: mockHome });
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

test('trashCachePath batch trashing executes Finder delete for all paths when confirm is true', async () => {
  const trashedPaths = [];
  const runner = {
    execFile: async (file, args) => {
      if (file === 'osascript') {
        const match = args[1].match(/delete POSIX file "(.+?)"/);
        if (match) {
          // Replace escaped quotes if any, but since we are simple:
          trashedPaths.push(match[1]);
        }
        return { stdout: '' };
      }
      return { stdout: '' };
    }
  };
  
  const mockHome = '/Users/nonexistent-test-user-home';
  const path1 = path.join(mockHome, '.npm', '_cacache');
  const path2 = path.join(mockHome, '.bun');
  const service = createPortService({ runner, homeDir: mockHome });
  const result = await service.trashCachePath({
    paths: [path1, path2],
    confirm: true
  });
  
  assert.deepEqual(result, { ok: true, trashed: true, paths: [path1, path2] });
  assert.deepEqual(trashedPaths, [path1, path2]);
});

test('trashCachePath batch returns dryRun object when confirm is false', async () => {
  const runner = {
    execFile: async (file) => {
      if (file === 'lsof') return { stdout: '' };
      throw new Error('should not execute shell commands on dry run');
    }
  };
  
  const path1 = path.join(os.homedir(), '.npm', '_cacache');
  const path2 = path.join(os.homedir(), '.bun');
  const service = createPortService({ runner });
  const result = await service.trashCachePath({
    paths: [path1, path2],
    confirm: false
  });
  
  assert.deepEqual(result, { dryRun: true, wouldTrash: [path1, path2] });
});

test('trashCachePath throws ACTIVE_PROCESS_LOCK 409 PortManagerError when active port process contains target path in commandLine', async () => {
  const targetPath = path.join(os.homedir(), '.npm', '_cacache');
  const activeProcess = {
    port: 8080,
    pid: 1234,
    processName: 'node',
    user: 'yoni',
    type: 'IPv4',
    protocol: 'TCP',
    address: '*:8080',
    commandLine: `node ${targetPath}/server.js`
  };

  const service = createPortService({
    listPorts: async () => [activeProcess]
  });

  await assert.rejects(
    async () => {
      await service.trashCachePath({ path: targetPath, confirm: true });
    },
    (err) => {
      assert.ok(err instanceof Error);
      assert.equal(err.name, 'PortManagerError');
      assert.equal(err.status, 409);
      assert.equal(err.code, 'ACTIVE_PROCESS_LOCK');
      return true;
    }
  );
});
