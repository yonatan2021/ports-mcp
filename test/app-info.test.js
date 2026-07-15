const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { createApp } = require('../src/http-server');
const { createAppInfoProvider, isNewerVersion } = require('../src/app-info');
const httpServerSource = require('node:fs').readFileSync(require.resolve('../src/http-server'), 'utf8');

test('isNewerVersion compares semantic versions with optional v prefixes', () => {
  assert.equal(isNewerVersion('v1.1.0', '1.0.1'), true);
  assert.equal(isNewerVersion('1.0.1', 'v1.0.1'), false);
  assert.equal(isNewerVersion('1.0.0', '1.0.1'), false);
});

test('app info provider reports current version and a newer GitHub release', async () => {
  const requests = [];
  const fetchImpl = async (url, options) => {
    requests.push({ url, options });
    return {
      ok: true,
      json: async () => ({
        tag_name: 'v1.1.0',
        html_url: 'https://github.com/yonatan2021/ports-mcp/releases/tag/v1.1.0',
      }),
    };
  };
  const getAppInfo = createAppInfoProvider({ currentVersion: '1.0.1', fetchImpl });

  const info = await getAppInfo();

  assert.deepEqual(info, {
    currentVersion: '1.0.1',
    latestVersion: '1.1.0',
    updateAvailable: true,
    releaseUrl: 'https://github.com/yonatan2021/ports-mcp/releases/tag/v1.1.0',
  });
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, 'https://api.github.com/repos/yonatan2021/ports-mcp/releases/latest');
  assert.equal(requests[0].options.headers['User-Agent'], 'ports-mcp/1.0.1');
});

test('GET /api/app-info exposes app information', async () => {
  const expected = {
    currentVersion: '1.0.1',
    latestVersion: '1.1.0',
    updateAvailable: true,
    releaseUrl: 'https://github.com/yonatan2021/ports-mcp/releases/tag/v1.1.0',
  };
  const app = createApp({ service: {}, getAppInfo: async () => expected });
  const server = http.createServer(app);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));

  try {
    const { port } = server.address();
    const response = await fetch(`http://127.0.0.1:${port}/api/app-info`);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), expected);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});

test('POST /api/app-update requires the per-process token before applying an update', async () => {
  let applyCount = 0;
  const app = createApp({
    service: {},
    getAppInfo: async () => ({ currentVersion: '1.0.1' }),
    updateToken: 'test-update-token',
    applyAppUpdate: async () => {
      applyCount += 1;
      return { ok: true, handedOff: true, version: '1.1.0' };
    },
  });
  const server = http.createServer(app);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));

  try {
    const { port } = server.address();
    const url = `http://127.0.0.1:${port}/api/app-update`;
    const denied = await fetch(url, { method: 'POST' });
    assert.equal(denied.status, 403);
    assert.equal(applyCount, 0);

    const accepted = await fetch(url, {
      method: 'POST',
      headers: { 'X-Update-Token': 'test-update-token' },
    });
    assert.equal(accepted.status, 200);
    assert.deepEqual(await accepted.json(), { ok: true, handedOff: true, version: '1.1.0' });
    assert.equal(applyCount, 1);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});

test('the app update route disables the normal request timeout for large downloads', () => {
  assert.match(
    httpServerSource,
    /app\.post\('\/api\/app-update'[\s\S]*?req\.setTimeout\(0\);[\s\S]*?res\.setTimeout\(0\);/
  );
});
