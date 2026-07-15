const { isNewerVersion, normalizeVersion } = require('./app-info');
const crypto = require('node:crypto');
const { execFile, spawn } = require('node:child_process');
const fs = require('node:fs');
const fsPromises = require('node:fs/promises');
const path = require('node:path');
const { Readable, Transform } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const { promisify } = require('node:util');

const execFileAsync = promisify(execFile);

const RELEASE_DOWNLOAD_PREFIX = 'https://github.com/yonatan2021/ports-mcp/releases/download/';
const MIN_UPDATE_BYTES = 1_000_000;
const MAX_UPDATE_BYTES = 500_000_000;
const LATEST_RELEASE_API = 'https://api.github.com/repos/yonatan2021/ports-mcp/releases/latest';

function selectMacReleaseAsset(release, { arch, currentVersion } = {}) {
  if (!release || release.draft || release.prerelease || !Array.isArray(release.assets)) {
    throw new Error('No verified macOS update release is available');
  }

  const version = normalizeVersion(release.tag_name);
  if (!isNewerVersion(version, currentVersion)) {
    throw new Error('Release is not newer than the installed version');
  }
  if (!['arm64', 'x64'].includes(arch)) {
    throw new Error(`Unsupported macOS architecture: ${arch || 'unknown'}`);
  }

  const expectedName = `Port-Manager-${version}-${arch}.zip`;
  const asset = release.assets.find(candidate => {
    const digest = String(candidate?.digest || '');
    const url = String(candidate?.browser_download_url || '');
    const size = Number(candidate?.size);
    return candidate?.name === expectedName &&
      /^sha256:[a-f0-9]{64}$/i.test(digest) &&
      url.startsWith(RELEASE_DOWNLOAD_PREFIX) &&
      url.endsWith(`/${expectedName}`) &&
      Number.isInteger(size) &&
      size >= MIN_UPDATE_BYTES &&
      size <= MAX_UPDATE_BYTES;
  });

  if (!asset) {
    throw new Error(`Release does not contain a verified ${arch} update ZIP`);
  }

  return {
    version,
    name: asset.name,
    digest: asset.digest.slice('sha256:'.length).toLowerCase(),
    url: asset.browser_download_url,
    size: asset.size,
  };
}

async function downloadAsset(asset, { destination, fetchImpl = globalThis.fetch } = {}) {
  if (!asset?.url || !asset?.digest || !Number.isInteger(asset?.size)) {
    throw new TypeError('A release asset with URL, digest, and size is required');
  }
  if (!destination) throw new TypeError('destination is required');

  const response = await fetchImpl(asset.url, {
    headers: { 'User-Agent': 'ports-mcp-updater' },
    redirect: 'follow',
    signal: AbortSignal.timeout(120_000),
  });
  if (!response.ok || !response.body) {
    throw new Error(`Update download failed with HTTP ${response.status || 'unknown'}`);
  }

  const hash = crypto.createHash('sha256');
  let receivedBytes = 0;
  const verifier = new Transform({
    transform(chunk, _encoding, callback) {
      receivedBytes += chunk.length;
      if (receivedBytes > asset.size) {
        callback(new Error('Update download exceeded the declared asset size'));
        return;
      }
      hash.update(chunk);
      callback(null, chunk);
    },
  });

  try {
    await pipeline(
      Readable.fromWeb(response.body),
      verifier,
      fs.createWriteStream(destination, { flags: 'w', mode: 0o600 })
    );
    const actualDigest = hash.digest('hex');
    if (receivedBytes !== asset.size || actualDigest !== asset.digest) {
      throw new Error('Update checksum verification failed');
    }
    return { destination, bytes: receivedBytes, digest: actualDigest };
  } catch (error) {
    await fsPromises.rm(destination, { force: true }).catch(() => {});
    throw error;
  }
}

async function defaultRun(command, args) {
  const { stdout } = await execFileAsync(command, args, { encoding: 'utf8' });
  return stdout;
}

async function verifyStagedApp({ appPath, expectedVersion, arch, run = defaultRun } = {}) {
  if (!path.isAbsolute(appPath || '') || path.basename(appPath) !== 'Port Manager.app') {
    throw new Error('Staged update must be an absolute Port Manager.app path');
  }
  const infoPlist = path.join(appPath, 'Contents', 'Info.plist');
  const executable = path.join(appPath, 'Contents', 'MacOS', 'Port Manager');

  await run('/usr/bin/codesign', ['--verify', '--deep', '--strict', appPath]);
  const bundleId = String(await run('/usr/bin/plutil', [
    '-extract', 'CFBundleIdentifier', 'raw', '-o', '-', infoPlist,
  ])).trim();
  if (bundleId !== 'com.yonatan2021.portsmcp') {
    throw new Error(`Update bundle identifier mismatch: ${bundleId || 'missing'}`);
  }

  const version = normalizeVersion(await run('/usr/bin/plutil', [
    '-extract', 'CFBundleShortVersionString', 'raw', '-o', '-', infoPlist,
  ]));
  if (version !== normalizeVersion(expectedVersion)) {
    throw new Error(`Update version mismatch: expected ${expectedVersion}, received ${version || 'missing'}`);
  }

  const architectures = String(await run('/usr/bin/lipo', ['-archs', executable])).trim().split(/\s+/).filter(Boolean);
  const requiredArchitecture = arch === 'x64' ? 'x86_64' : arch;
  if (!architectures.includes(requiredArchitecture)) {
    throw new Error(`Update architecture mismatch: expected ${requiredArchitecture}`);
  }

  return { appPath, bundleId, version, architectures };
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function resolveRunningAppBundle(execPath) {
  if (!path.isAbsolute(execPath || '')) return null;
  const executable = path.resolve(execPath);
  const macosDir = path.dirname(executable);
  const contentsDir = path.dirname(macosDir);
  const appBundle = path.dirname(contentsDir);
  if (
    path.basename(executable) !== 'Port Manager' ||
    path.basename(macosDir) !== 'MacOS' ||
    path.basename(contentsDir) !== 'Contents' ||
    path.basename(appBundle) !== 'Port Manager.app'
  ) {
    return null;
  }
  return appBundle;
}

function buildSwapScript({ pid, sourceApp, targetApp, workDir = null } = {}) {
  if (!Number.isInteger(pid) || pid < 1) throw new TypeError('pid must be a positive integer');
  for (const [label, appPath] of [['sourceApp', sourceApp], ['targetApp', targetApp]]) {
    if (!path.isAbsolute(appPath || '') || path.basename(appPath) !== 'Port Manager.app') {
      throw new TypeError(`${label} must be an absolute Port Manager.app path`);
    }
  }

  if (workDir && !path.isAbsolute(workDir)) throw new TypeError('workDir must be an absolute path');

  return `#!/bin/bash
set -u
APP_PID=${pid}
SRC=${shellQuote(sourceApp)}
DST=${shellQuote(targetApp)}
NEW="\${DST}.update-new"
OLD="\${DST}.update-old"
SCRIPT_PATH="$0"
OPENED=0
cleanup() {
  rm -f "$SCRIPT_PATH" 2>/dev/null || true
  if [ "$OPENED" -eq 0 ] && [ -d "$DST" ]; then /usr/bin/open "$DST" 2>/dev/null || true; fi
}
trap cleanup EXIT
for _ in $(seq 1 120); do
  kill -0 "$APP_PID" 2>/dev/null || break
  sleep 0.25
done
if kill -0 "$APP_PID" 2>/dev/null; then
  exit 1
fi
rm -rf "$NEW" "$OLD"
if ! /usr/bin/ditto "$SRC" "$NEW"; then
  rm -rf "$NEW"
  exit 1
fi
if ! /usr/bin/codesign --verify --deep --strict "$NEW"; then
  rm -rf "$NEW"
  exit 1
fi
if ! mv "$DST" "$OLD"; then
  rm -rf "$NEW"
  exit 1
fi
if ! mv "$NEW" "$DST"; then
  mv "$OLD" "$DST" 2>/dev/null || true
  exit 1
fi
if ! /usr/bin/open "$DST"; then
  rm -rf "$DST"
  mv "$OLD" "$DST" 2>/dev/null || true
  exit 1
fi
OPENED=1
rm -rf "$OLD"
${workDir ? `rm -rf ${shellQuote(workDir)}` : ''}
`;
}

async function fetchLatestRelease(fetchImpl = globalThis.fetch) {
  const response = await fetchImpl(LATEST_RELEASE_API, {
    headers: {
      Accept: 'application/vnd.github+json',
      'User-Agent': 'ports-mcp-updater',
      'X-GitHub-Api-Version': '2022-11-28',
    },
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error(`Could not check GitHub release: HTTP ${response.status}`);
  return response.json();
}

async function extractArchive(archivePath, destination, run = defaultRun) {
  await fsPromises.mkdir(destination, { recursive: true, mode: 0o700 });
  await run('/usr/bin/ditto', ['-x', '-k', archivePath, destination]);
}

async function ensureWritableTarget(targetApp) {
  if (!path.isAbsolute(targetApp || '') || path.basename(targetApp) !== 'Port Manager.app') {
    throw new Error('Installed Port Manager.app path could not be resolved');
  }
  await fsPromises.access(path.dirname(targetApp), fs.constants.W_OK);
}

async function launchSwap({ sourceApp, targetApp, workDir, tempDir, pid = process.pid } = {}) {
  const script = buildSwapScript({ pid, sourceApp, targetApp, workDir });
  const scriptPath = path.join(tempDir, `ports-mcp-update-${Date.now()}.sh`);
  await fsPromises.writeFile(scriptPath, script, { mode: 0o700 });
  const child = spawn('/bin/bash', [scriptPath], { detached: true, stdio: 'ignore' });
  await new Promise((resolve, reject) => {
    child.once('spawn', resolve);
    child.once('error', reject);
  });
  child.unref();
  return { scriptPath };
}

function createMacAppUpdater({
  currentVersion,
  arch,
  targetApp,
  tempDir,
  fetchRelease = fetchLatestRelease,
  download = downloadAsset,
  extract = extractArchive,
  verify = verifyStagedApp,
  ensureWritable = ensureWritableTarget,
  launch = launchSwap,
} = {}) {
  if (!currentVersion || !arch || !targetApp || !tempDir) {
    throw new TypeError('currentVersion, arch, targetApp, and tempDir are required');
  }
  let applying = false;

  return {
    async apply() {
      if (applying) throw new Error('An update is already in progress');
      applying = true;
      let workDir;

      try {
        await ensureWritable(targetApp);
        const release = await fetchRelease();
        const asset = selectMacReleaseAsset(release, { arch, currentVersion });
        workDir = await fsPromises.mkdtemp(path.join(tempDir, 'ports-mcp-update-'));
        const archivePath = path.join(workDir, asset.name);
        const extractDir = path.join(workDir, 'extracted');
        const stagedApp = path.join(extractDir, 'Port Manager.app');

        await download(asset, { destination: archivePath });
        await extract(archivePath, extractDir);
        await verify({ appPath: stagedApp, expectedVersion: asset.version, arch });
        const handoff = await launch({
          pid: process.pid,
          sourceApp: stagedApp,
          targetApp,
          workDir,
          tempDir,
        });

        return { ok: true, handedOff: true, version: asset.version, ...handoff };
      } catch (error) {
        applying = false;
        if (workDir) await fsPromises.rm(workDir, { recursive: true, force: true }).catch(() => {});
        throw error;
      }
    },
  };
}

module.exports = {
  buildSwapScript,
  createMacAppUpdater,
  downloadAsset,
  ensureWritableTarget,
  extractArchive,
  fetchLatestRelease,
  launchSwap,
  LATEST_RELEASE_API,
  MAX_UPDATE_BYTES,
  MIN_UPDATE_BYTES,
  RELEASE_DOWNLOAD_PREFIX,
  resolveRunningAppBundle,
  selectMacReleaseAsset,
  verifyStagedApp,
};
