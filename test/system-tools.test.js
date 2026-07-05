const test = require('node:test');
const assert = require('node:assert/strict');
const { createAgentTools } = require('../src/mcp-tools');

test('getSystemUsage tool returns stats', async () => {
  const serviceMock = {
    getSystemUsage: async () => ({ cpu: 15, memory: { percentage: 40 } })
  };
  const tools = createAgentTools({ service: serviceMock });
  const result = await tools.getSystemUsage();
  assert.equal(result.ok, true);
  assert.equal(result.data.cpu, 15);
});

test('listSystemProcesses tool returns processes', async () => {
  const serviceMock = {
    getSystemProcesses: async () => [{ pid: 123, processName: 'node' }]
  };
  const tools = createAgentTools({ service: serviceMock });
  const result = await tools.listSystemProcesses();
  assert.equal(result.ok, true);
  assert.equal(result.data.processes[0].pid, 123);
});

test('suspendProcess and resumeProcess tools execute actions', async () => {
  const calls = [];
  const serviceMock = {
    suspendProcess: async ({ pid }) => { calls.push(['suspend', pid]); return { ok: true }; },
    resumeProcess: async ({ pid }) => { calls.push(['resume', pid]); return { ok: true }; }
  };
  const tools = createAgentTools({ service: serviceMock });

  await tools.suspendProcess({ pid: 12 });
  await tools.resumeProcess({ pid: 34 });

  assert.deepEqual(calls, [
    ['suspend', 12],
    ['resume', 34]
  ]);
});
