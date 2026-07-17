const test = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('../src/http-server');
const http = require('node:http');

test('GET /api/system/usage returns stats', async () => {
  const serviceMock = {
    getSystemUsage: async () => ({ cpu: 10, memory: { percentage: 50, usedBytes: 1000, totalBytes: 2000 } })
  };
  const app = createApp({ service: serviceMock });
  
  const server = http.createServer(app);
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const address = server.address();
  const url = `http://127.0.0.1:${address.port}/api/system/usage`;
  
  try {
    const res = await fetch(url);
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.cpu, 10);
    assert.equal(data.memory.percentage, 50);
  } finally {
    await new Promise(r => server.close(r));
  }
});

test('GET /api/system/storage returns disk and cache usage', async () => {
  const serviceMock = {
    getStorageUsage: async () => ({ disk: { percentage: 40 }, cache: { knownBytes: 1024, items: [] } })
  };
  const app = createApp({ service: serviceMock });
  const server = http.createServer(app);
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const address = server.address();

  try {
    const res = await fetch(`http://127.0.0.1:${address.port}/api/system/storage`);
    assert.equal(res.status, 200);
    assert.equal((await res.json()).disk.percentage, 40);
  } finally {
    await new Promise(r => server.close(r));
  }
});

test('GET /api/system/processes returns processes list', async () => {
  const serviceMock = {
    getSystemProcesses: async () => [{ pid: 123, processName: 'node', cpu: 5.5, memoryMb: 128.0 }]
  };
  const app = createApp({ service: serviceMock });
  
  const server = http.createServer(app);
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const address = server.address();
  const url = `http://127.0.0.1:${address.port}/api/system/processes`;
  
  try {
    const res = await fetch(url);
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.processes[0].pid, 123);
  } finally {
    await new Promise(r => server.close(r));
  }
});

test('POST /api/system/suspend, resume, and kill perform actions on service', async () => {
  const calls = [];
  const serviceMock = {
    suspendProcess: async ({ pid }) => { calls.push(['suspend', pid]); return { ok: true, pid }; },
    resumeProcess: async ({ pid }) => { calls.push(['resume', pid]); return { ok: true, pid }; },
    killProcess: async ({ pid, confirm }) => { calls.push(['kill', pid, confirm]); return { ok: true, pid }; }
  };
  const app = createApp({ service: serviceMock });
  
  const server = http.createServer(app);
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const address = server.address();
  
  const fetchPost = async (path, body) => {
    return fetch(`http://127.0.0.1:${address.port}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
  };

  try {
    const res1 = await fetchPost('/api/system/suspend', { pid: 123 });
    assert.equal(res1.status, 200);
    
    const res2 = await fetchPost('/api/system/resume', { pid: 456 });
    assert.equal(res2.status, 200);

    const res3 = await fetchPost('/api/system/kill', { pid: 789, confirm: true });
    assert.equal(res3.status, 200);
    
    assert.deepEqual(calls, [
      ['suspend', 123],
      ['resume', 456],
      ['kill', 789, true]
    ]);
  } finally {
    await new Promise(r => server.close(r));
  }
});

test('POST /api/system/suspend, resume, and kill return 400 for invalid PID', async () => {
  const app = createApp({ service: {} });
  
  const server = http.createServer(app);
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const address = server.address();
  
  const fetchPost = async (path, body) => {
    return fetch(`http://127.0.0.1:${address.port}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
  };

  try {
    const endpoints = ['/api/system/suspend', '/api/system/resume', '/api/system/kill'];
    for (const ep of endpoints) {
      // Missing PID
      const r1 = await fetchPost(ep, {});
      assert.equal(r1.status, 400);
      const d1 = await r1.json();
      assert.equal(d1.error.code, 'INVALID_PID');

      // String PID
      const r2 = await fetchPost(ep, { pid: 'not-an-integer' });
      assert.equal(r2.status, 400);
      const d2 = await r2.json();
      assert.equal(d2.error.code, 'INVALID_PID');

      // Negative PID
      const r3 = await fetchPost(ep, { pid: -5 });
      assert.equal(r3.status, 400);
      const d3 = await r3.json();
      assert.equal(d3.error.code, 'INVALID_PID');
    }
  } finally {
    await new Promise(r => server.close(r));
  }
});

test('GET /api/system/cache returns cache array', async () => {
  const serviceMock = {
    getCacheDetails: async () => [{ path: '/test/cache/path', sizeBytes: 500, fileCount: 5 }]
  };
  const app = createApp({ service: serviceMock });
  
  const server = http.createServer(app);
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const address = server.address();
  const url = `http://127.0.0.1:${address.port}/api/system/cache`;
  
  try {
    const res = await fetch(url);
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.deepEqual(data, { items: [{ path: '/test/cache/path', sizeBytes: 500, fileCount: 5 }] });
  } finally {
    await new Promise(r => server.close(r));
  }
});

test('POST /api/system/cache/trash triggers trashCachePath and returns result', async () => {
  let calledWith = null;
  const serviceMock = {
    trashCachePath: async (args) => {
      calledWith = args;
      return { ok: true, path: args.path, deletedBytes: 100 };
    }
  };
  const app = createApp({ service: serviceMock });
  
  const server = http.createServer(app);
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const address = server.address();
  const url = `http://127.0.0.1:${address.port}/api/system/cache/trash`;
  
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: '/test/cache/path', confirm: true })
    });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.deepEqual(data, { ok: true, path: '/test/cache/path', deletedBytes: 100 });
    assert.deepEqual(calledWith, { path: '/test/cache/path', confirm: true });
  } finally {
    await new Promise(r => server.close(r));
  }
});
