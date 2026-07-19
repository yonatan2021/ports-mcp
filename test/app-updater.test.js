const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { Readable } = require('node:stream');
const {
  buildSwapScript,
  createMacAppUpdater,
  downloadAsset,
  resolveRunningAppBundle,
  selectMacReleaseAsset,
  verifyStagedApp,
} = require('../src/app-updater');

const release = {
  tag_name: 'v1.1.0',
  draft: false,
  prerelease: false,
  assets: [
    {
      name: 'Port-Manager-1.1.0-arm64.zip',
      digest: `sha256:${'a'.repeat(64)}`,
      browser_download_url: 'https://github.com/yonatan2021/ports-mcp/releases/download/v1.1.0/Port-Manager-1.1.0-arm64.zip',
      size: 120_000_000,
    },
    {
      name: 'Port-Manager-1.1.0-x64.zip',
      digest: `sha256:${'b'.repeat(64)}`,
      browser_download_url: 'https://github.com/yonatan2021/ports-mcp/releases/download/v1.1.0/Port-Manager-1.1.0-x64.zip',
      size: 121_000_000,
    },
  ],
};

test('selectMacReleaseAsset selects the trusted ZIP for the current architecture', () => {
  assert.deepEqual(selectMacReleaseAsset(release, { arch: 'arm64', currentVersion: '1.0.1' }), {
    version: '1.1.0',
    name: 'Port-Manager-1.1.0-arm64.zip',
    digest: 'a'.repeat(64),
    url: 'https://github.com/yonatan2021/ports-mcp/releases/download/v1.1.0/Port-Manager-1.1.0-arm64.zip',
    size: 120_000_000,
  });
});

test('selectMacReleaseAsset rejects untrusted or unverifiable release assets', () => {
  const missingDigest = structuredClone(release);
  missingDigest.assets[0].digest = null;
  assert.throws(
    () => selectMacReleaseAsset(missingDigest, { arch: 'arm64', currentVersion: '1.0.1' }),
    /verified arm64 update ZIP/
  );

  const untrustedUrl = structuredClone(release);
  untrustedUrl.assets[0].browser_download_url = 'https://example.com/update.zip';
  assert.throws(
    () => selectMacReleaseAsset(untrustedUrl, { arch: 'arm64', currentVersion: '1.0.1' }),
    /verified arm64 update ZIP/
  );
});

test('downloadAsset streams a release ZIP and verifies its SHA-256 digest and size', async () => {
  const bytes = Buffer.from('verified update archive');
  const asset = {
    url: 'https://github.com/yonatan2021/ports-mcp/releases/download/v1.1.0/Port-Manager-1.1.0-arm64.zip',
    digest: crypto.createHash('sha256').update(bytes).digest('hex'),
    size: bytes.length,
  };
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'ports-update-test-'));
  const destination = path.join(directory, 'update.zip');
  const fetchImpl = async () => ({
    ok: true,
    body: Readable.toWeb(Readable.from([bytes])),
  });

  try {
    await downloadAsset(asset, { destination, fetchImpl });
    assert.deepEqual(await fs.readFile(destination), bytes);

    await assert.rejects(
      downloadAsset({ ...asset, digest: '0'.repeat(64) }, { destination, fetchImpl }),
      /checksum verification failed/
    );
    await assert.rejects(fs.access(destination));
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('verifyStagedApp validates signature, app identity, version, and architecture', async () => {
  const calls = [];
  const run = async (command, args) => {
    calls.push([command, args]);
    if (command === '/usr/bin/plutil' && args[1] === 'CFBundleIdentifier') return 'com.yonatan2021.portsmcp\n';
    if (command === '/usr/bin/plutil' && args[1] === 'CFBundleShortVersionString') return '1.1.0\n';
    if (command === '/usr/bin/lipo') return 'arm64\n';
    return '';
  };

  const result = await verifyStagedApp({
    appPath: '/tmp/Port Manager.app',
    expectedVersion: '1.1.0',
    arch: 'arm64',
    run,
  });

  assert.deepEqual(result, {
    appPath: '/tmp/Port Manager.app',
    bundleId: 'com.yonatan2021.portsmcp',
    version: '1.1.0',
    architectures: ['arm64'],
  });
  assert.equal(calls[0][0], '/usr/bin/codesign');
  assert.deepEqual(calls[0][1], ['--verify', '--deep', '--strict', '/tmp/Port Manager.app']);
});

test('buildSwapScript stages atomically, rolls back on failure, and relaunches', () => {
  const script = buildSwapScript({
    pid: 1234,
    sourceApp: "/tmp/update/Port Manager.app",
    targetApp: "/Applications/Port Manager.app",
  });

  assert.match(script, /\/usr\/bin\/ditto "\$SRC" "\$NEW"/);
  assert.match(script, /\/usr\/bin\/codesign --verify --deep --strict "\$NEW"/);
  assert.match(script, /mv "\$DST" "\$OLD"/);
  assert.match(script, /mv "\$OLD" "\$DST"/);
  assert.match(script, /\/usr\/bin\/open "\$DST"/);
  assert.match(script, /if ! \/usr\/bin\/open "\$DST"/);
  assert.match(script, /rm -rf "\$DST"/);
  assert.match(script, /trap cleanup EXIT/);
  assert.match(script, /APP_PID=1234/);
});

test('createMacAppUpdater downloads, extracts, verifies, and hands off a newer release', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'ports-updater-flow-'));
  const calls = [];
  const updater = createMacAppUpdater({
    currentVersion: '1.0.1',
    arch: 'arm64',
    targetApp: '/Applications/Port Manager.app',
    tempDir: directory,
    fetchRelease: async () => release,
    ensureWritable: async () => {},
    download: async (asset, options) => {
      calls.push(['download', asset.name]);
      await fs.writeFile(options.destination, 'archive');
    },
    extract: async (_archive, destination) => {
      calls.push(['extract']);
      await fs.mkdir(path.join(destination, 'Port Manager.app'), { recursive: true });
    },
    verify: async options => {
      calls.push(['verify', options.expectedVersion, options.arch]);
      return { appPath: options.appPath };
    },
    launch: async options => {
      calls.push(['launch', options.sourceApp, options.targetApp]);
      return { scriptPath: '/tmp/updater.sh' };
    },
  });

  try {
    const result = await updater.apply();
    assert.equal(result.ok, true);
    assert.equal(result.handedOff, true);
    assert.equal(result.version, '1.1.0');
    assert.deepEqual(calls.map(call => call[0]), ['download', 'extract', 'verify', 'launch']);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('resolveRunningAppBundle accepts only the packaged Port Manager executable layout', () => {
  assert.equal(
    resolveRunningAppBundle('/Applications/Port Manager.app/Contents/MacOS/Port Manager'),
    '/Applications/Port Manager.app'
  );
  assert.equal(resolveRunningAppBundle('/usr/local/bin/electron'), null);
  assert.equal(resolveRunningAppBundle('/Applications/Other.app/Contents/MacOS/Other'), null);
});

test('downloadAsset rejects when download size exceeds declared asset size', async () => {
  const bytes = Buffer.from('verified update archive');
  const asset = {
    url: 'https://github.com/yonatan2021/ports-mcp/releases/download/v1.1.0/Port-Manager-1.1.0-arm64.zip',
    digest: crypto.createHash('sha256').update(bytes).digest('hex'),
    size: bytes.length - 5, // make declared size smaller
  };
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'ports-update-size-test-'));
  const destination = path.join(directory, 'update.zip');
  const fetchImpl = async () => ({
    ok: true,
    body: Readable.toWeb(Readable.from([bytes])),
  });

  try {
    await assert.rejects(
      downloadAsset(asset, { destination, fetchImpl }),
      /exceeded the declared asset size/
    );
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('downloadAsset rejects when HTTP response is not ok', async () => {
  const asset = {
    url: 'https://github.com/yonatan2021/ports-mcp/releases/download/v1.1.0/Port-Manager-1.1.0-arm64.zip',
    digest: 'a'.repeat(64),
    size: 100,
  };
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'ports-update-http-test-'));
  const destination = path.join(directory, 'update.zip');
  const fetchImpl = async () => ({
    ok: false,
    status: 404,
  });

  try {
    await assert.rejects(
      downloadAsset(asset, { destination, fetchImpl }),
      /Update download failed with HTTP 404/
    );
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('verifyStagedApp rejects when codesign verify fails', async () => {
  const run = async (command, args) => {
    if (command === '/usr/bin/codesign') {
      throw new Error('codesign verification failed');
    }
    return '';
  };

  await assert.rejects(
    () => verifyStagedApp({
      appPath: '/tmp/Port Manager.app',
      expectedVersion: '1.1.0',
      arch: 'arm64',
      run,
    }),
    /codesign verification failed/
  );
});

test('verifyStagedApp rejects when bundle ID mismatches', async () => {
  const run = async (command, args) => {
    if (command === '/usr/bin/plutil' && args[1] === 'CFBundleIdentifier') return 'com.malicious.app\n';
    if (command === '/usr/bin/plutil' && args[1] === 'CFBundleShortVersionString') return '1.1.0\n';
    if (command === '/usr/bin/lipo') return 'arm64\n';
    return '';
  };

  await assert.rejects(
    () => verifyStagedApp({
      appPath: '/tmp/Port Manager.app',
      expectedVersion: '1.1.0',
      arch: 'arm64',
      run,
    }),
    /Update bundle identifier mismatch: com.malicious.app/
  );
});

test('verifyStagedApp rejects when version mismatches', async () => {
  const run = async (command, args) => {
    if (command === '/usr/bin/plutil' && args[1] === 'CFBundleIdentifier') return 'com.yonatan2021.portsmcp\n';
    if (command === '/usr/bin/plutil' && args[1] === 'CFBundleShortVersionString') return '1.2.0\n';
    if (command === '/usr/bin/lipo') return 'arm64\n';
    return '';
  };

  await assert.rejects(
    () => verifyStagedApp({
      appPath: '/tmp/Port Manager.app',
      expectedVersion: '1.1.0',
      arch: 'arm64',
      run,
    }),
    /Update version mismatch: expected 1.1.0, received 1.2.0/
  );
});

test('verifyStagedApp rejects when architecture mismatches', async () => {
  const run = async (command, args) => {
    if (command === '/usr/bin/plutil' && args[1] === 'CFBundleIdentifier') return 'com.yonatan2021.portsmcp\n';
    if (command === '/usr/bin/plutil' && args[1] === 'CFBundleShortVersionString') return '1.1.0\n';
    if (command === '/usr/bin/lipo') return 'x86_64\n';
    return '';
  };

  await assert.rejects(
    () => verifyStagedApp({
      appPath: '/tmp/Port Manager.app',
      expectedVersion: '1.1.0',
      arch: 'arm64',
      run,
    }),
    /Update architecture mismatch: expected arm64/
  );
});

