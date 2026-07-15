const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { startLocalServer } = require('../src/desktop-server');

test('startLocalServer binds only to loopback and returns a usable local URL', async () => {
  const app = express();
  app.get('/health', (_req, res) => res.json({ ok: true }));

  const localServer = await startLocalServer({ app, port: 0 });

  try {
    assert.equal(localServer.host, '127.0.0.1');
    assert.match(localServer.url, /^http:\/\/127\.0\.0\.1:\d+$/);

    const response = await fetch(`${localServer.url}/health`);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ok: true });
  } finally {
    await localServer.close();
  }
});

test('startLocalServer rejects invalid port values before binding', async () => {
  const app = express();

  await assert.rejects(
    startLocalServer({ app, port: 70000 }),
    /port must be an integer between 0 and 65535/
  );
});
