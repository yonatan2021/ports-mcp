const test = require('node:test');
const assert = require('node:assert/strict');
const { createMcpServer } = require('../src/mcp-server');

class MockTransport {
  constructor() {
    this.sent = [];
    this.onmessage = null;
    this.onclose = null;
    this.onerror = null;
    this.started = false;
  }

  async start() {
    this.started = true;
  }

  async send(message) {
    this.sent.push(message);
  }

  async close() {
    this.started = false;
    if (this.onclose) this.onclose();
  }

  simulateMessage(msg) {
    if (this.onmessage) {
      this.onmessage(msg);
    }
  }
}

async function performHandshake(transport) {
  const initPromise = new Promise((resolve) => {
    const checkResponse = () => {
      const resp = transport.sent.find(m => m.id === 1);
      if (resp) resolve(resp);
      else setTimeout(checkResponse, 5);
    };
    checkResponse();
  });

  transport.simulateMessage({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'test-client', version: '1.0.0' }
    }
  });

  await initPromise;

  transport.simulateMessage({
    jsonrpc: '2.0',
    method: 'notifications/initialized'
  });
}

async function getResponseForId(transport, id) {
  return new Promise((resolve) => {
    const checkResponse = () => {
      const resp = transport.sent.find(m => m.id === id);
      if (resp) resolve(resp);
      else setTimeout(checkResponse, 5);
    };
    checkResponse();
  });
}

test('MCP Server advertises all expected tools on tools/list', async () => {
  const serviceMock = {
    listPorts: async () => [],
    getCacheDetails: async () => []
  };

  const server = createMcpServer({ service: serviceMock });
  const transport = new MockTransport();
  await server.connect(transport);
  await performHandshake(transport);

  transport.simulateMessage({
    jsonrpc: '2.0',
    id: 2,
    method: 'tools/list'
  });

  const response = await getResponseForId(transport, 2);
  assert.ok(response);
  assert.ok(response.result);
  assert.ok(Array.isArray(response.result.tools));

  const toolNames = response.result.tools.map(t => t.name);
  assert.ok(toolNames.includes('list_ports'));
  assert.ok(toolNames.includes('find_process_by_port'));
  assert.ok(toolNames.includes('kill_process_on_port'));
  assert.ok(toolNames.includes('safe_kill_process'));
  assert.ok(toolNames.includes('get_safety_status'));
  assert.ok(toolNames.includes('list_caches'));
  assert.ok(toolNames.includes('clean_cache'));
});

test('MCP Server list_ports tool routes and returns mock data correctly', async () => {
  const portData = [
    {
      port: 3000,
      pid: 1234,
      processName: 'node',
      user: 'yoni',
      type: 'IPv4',
      protocol: 'TCP',
      address: '*:3000'
    }
  ];

  const serviceMock = {
    listPorts: async () => portData
  };

  const server = createMcpServer({ service: serviceMock });
  const transport = new MockTransport();
  await server.connect(transport);
  await performHandshake(transport);

  transport.simulateMessage({
    jsonrpc: '2.0',
    id: 3,
    method: 'tools/call',
    params: {
      name: 'list_ports',
      arguments: {}
    }
  });

  const response = await getResponseForId(transport, 3);
  assert.ok(response);
  assert.ok(response.result);
  assert.ok(Array.isArray(response.result.content));
  
  const textContent = JSON.parse(response.result.content[0].text);
  assert.deepEqual(textContent.ports, portData);
});

test('MCP Server input validation works for tools', async () => {
  const serviceMock = {};
  const server = createMcpServer({ service: serviceMock });
  const transport = new MockTransport();
  await server.connect(transport);
  await performHandshake(transport);

  // Call find_process_by_port with missing params
  transport.simulateMessage({
    jsonrpc: '2.0',
    id: 4,
    method: 'tools/call',
    params: {
      name: 'find_process_by_port',
      arguments: {} // missing port
    }
  });

  const response = await getResponseForId(transport, 4);
  assert.ok(response);
  assert.ok(response.error || response.result.isError);
});

test('MCP Server handles service errors correctly', async () => {
  const serviceMock = {
    listPorts: async () => {
      throw new Error('Database service unavailable');
    }
  };

  const server = createMcpServer({ service: serviceMock });
  const transport = new MockTransport();
  await server.connect(transport);
  await performHandshake(transport);

  transport.simulateMessage({
    jsonrpc: '2.0',
    id: 5,
    method: 'tools/call',
    params: {
      name: 'list_ports',
      arguments: {}
    }
  });

  const response = await getResponseForId(transport, 5);
  assert.ok(response);
  assert.ok(response.result || response.error);
  
  const result = response.result || response.error;
  assert.ok(result.isError || response.error);
});
