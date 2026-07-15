const test = require('node:test');
const assert = require('node:assert/strict');
const { createAgentTools } = require('../src/mcp-tools');
const { PortManagerError } = require('../src/port-service');

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
    suspendProcess: async ({ pid, confirm }) => { calls.push(['suspend', pid, confirm]); return { ok: true }; },
    resumeProcess: async ({ pid }) => { calls.push(['resume', pid]); return { ok: true }; }
  };
  const tools = createAgentTools({ service: serviceMock });

  await tools.suspendProcess({ pid: 12, confirm: true });
  await tools.resumeProcess({ pid: 34 });

  assert.deepEqual(calls, [
    ['suspend', 12, true],
    ['resume', 34]
  ]);
});

test('tools wrap service errors using wrapServiceError', async () => {
  const serviceMock = {
    getSystemUsage: async () => {
      throw new PortManagerError('TEST_ERROR', 'Service failed', { status: 400, details: { foo: 'bar' } });
    }
  };
  const tools = createAgentTools({ service: serviceMock });
  const result = await tools.getSystemUsage();
  
  assert.equal(result.error, true);
  assert.equal(result.code, 'TEST_ERROR');
  assert.equal(result.message, 'Service failed');
  assert.ok(result.safe_hint.includes('PortManagerError'));
});
