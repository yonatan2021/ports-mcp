const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createPortService } = require('../src/port-service');

test('getStorageUsage reports disk capacity and largest readable cache folders', async () => {
  const cacheDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ports-mcp-cache-'));
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
    const usage = await createPortService({ cacheDir, runner }).getStorageUsage();
    assert.deepEqual(usage.disk, { totalBytes: 1024000, usedBytes: 409600, availableBytes: 614400, percentage: 40 });
    assert.deepEqual(usage.cache.items, [
      { name: 'large', path: path.join(cacheDir, 'large'), bytes: 2097152 },
      { name: 'small', path: path.join(cacheDir, 'small'), bytes: 524288 }
    ]);
    assert.equal(usage.cache.knownBytes, 2621440);
    assert.equal(usage.cache.scannedItems, 2);
  } finally {
    await fs.rm(cacheDir, { recursive: true, force: true });
  }
});

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

