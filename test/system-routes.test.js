const test = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('../src/http-server');

test('GET /api/system/usage returns stats', async () => {
  const serviceMock = {
    getSystemUsage: async () => ({ cpu: 10, memory: { percentage: 50, usedBytes: 1000, totalBytes: 2000 } })
  };
  const app = createApp({ service: serviceMock });
  
  // We can use a test server to run the app and perform a fetch request
  const http = require('node:http');
  const server = http.createServer(app);
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const address = server.address();
  const url = `http://127.0.0.1:${address.port}/api/system/usage`;
  
  const res = await fetch(url);
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.cpu, 10);
  assert.equal(data.memory.percentage, 50);
  
  await new Promise(r => server.close(r));
});

test('GET /api/system/processes returns processes list', async () => {
  const serviceMock = {
    getSystemProcesses: async () => [{ pid: 123, processName: 'node', cpu: 5.5, memoryMb: 128.0 }]
  };
  const app = createApp({ service: serviceMock });
  
  const http = require('node:http');
  const server = http.createServer(app);
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const address = server.address();
  const url = `http://127.0.0.1:${address.port}/api/system/processes`;
  
  const res = await fetch(url);
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.processes[0].pid, 123);
  
  await new Promise(r => server.close(r));
});

test('POST /api/system/suspend, resume, and kill perform actions on service', async () => {
  const calls = [];
  const serviceMock = {
    suspendProcess: async ({ pid }) => { calls.push(['suspend', pid]); return { ok: true, pid }; },
    resumeProcess: async ({ pid }) => { calls.push(['resume', pid]); return { ok: true, pid }; },
    killProcess: async ({ pid, confirm }) => { calls.push(['kill', pid, confirm]); return { ok: true, pid }; }
  };
  const app = createApp({ service: serviceMock });
  
  const http = require('node:http');
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
  
  await new Promise(r => server.close(r));
});
