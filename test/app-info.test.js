const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { createApp } = require('../src/http-server');
const { createAppInfoProvider, isNewerVersion } = require('../src/app-info');

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

test('POST /api/app-update is not exposed over HTTP', async () => {
  const app = createApp({ service: {}, getAppInfo: async () => ({ currentVersion: '1.0.1' }) });
  const server = http.createServer(app);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));

  try {
    const { port } = server.address();
    const response = await fetch(`http://127.0.0.1:${port}/api/app-update`, { method: 'POST' });
    assert.equal(response.status, 404);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});

test('the local HTTP server rejects DNS-rebinding Host headers', async () => {
  const app = createApp({ service: {}, getAppInfo: async () => ({ currentVersion: '1.1.0' }) });
  const server = http.createServer(app);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));

  try {
    const { port } = server.address();
    const status = await new Promise((resolve, reject) => {
      const request = http.get({
        hostname: '127.0.0.1',
        port,
        path: '/api/app-info',
        headers: { Host: 'attacker.example' },
      }, response => {
        response.resume();
        resolve(response.statusCode);
      });
      request.on('error', reject);
    });
    assert.equal(status, 403);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});
