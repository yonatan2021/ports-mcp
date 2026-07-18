const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const path = require('node:path');
const fs = require('node:fs/promises');
const os = require('node:os');
const { createApp } = require('../src/http-server');
const { createPortService } = require('../src/port-service');
const { SafetyLayer } = require('../src/safety');
const { SafetyConfig } = require('../src/config');

// 1. Resiliency on system command failures
test('listPorts gracefully degrades when lsof fails completely', async () => {
  const runner = {
    execFile: async () => {
      throw new Error('lsof failed to execute');
    }
  };
  const service = createPortService({ runner });
  const ports = await service.listPorts();
  assert.deepEqual(ports, []);
});

test('listPorts gracefully degrades when ps fails completely', async () => {
  const runner = {
    execFile: async (file, args) => {
      if (file === 'lsof') {
        return { 
          stdout: 'COMMAND   PID USER   FD   TYPE             DEVICE SIZE/OFF NODE NAME\nnode    12345 username   21u  IPv4 0xabc123      0t0  TCP *:3000 (LISTEN)\n', 
          stderr: '', 
          exitCode: 0 
        };
      }
      throw new Error('ps failed to execute');
    }
  };
  const service = createPortService({ runner });
  const ports = await service.listPorts();
  assert.equal(ports.length, 1);
  assert.equal(ports[0].pid, 12345);
  assert.equal(ports[0].commandLine, 'Unknown command');
});

// 2. HTTP API boundary validation checks
test('HTTP API rejects invalid port arguments with structured error', async () => {
  const app = createApp({ service: {} });
  const server = http.createServer(app);
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const address = server.address();
  
  try {
    // Test invalid port string
    const res1 = await fetch(`http://127.0.0.1:${address.port}/api/ports/abc`);
    assert.equal(res1.status, 400);
    const errBody1 = await res1.json();
    assert.equal(errBody1.error.code, 'INVALID_PORT');
    
    // Test out of bounds port
    const res2 = await fetch(`http://127.0.0.1:${address.port}/api/ports/99999`);
    assert.equal(res2.status, 400);
    const errBody2 = await res2.json();
    assert.equal(errBody2.error.code, 'INVALID_PORT');
  } finally {
    await new Promise(r => server.close(r));
  }
});

test('HTTP API POST /api/ports/kill rejects invalid PID with 400', async () => {
  const app = createApp({ service: {} });
  const server = http.createServer(app);
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const address = server.address();
  
  try {
    const res = await fetch(`http://127.0.0.1:${address.port}/api/ports/kill`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ port: 3000, pid: -5 })
    });
    assert.equal(res.status, 400);
    const errBody = await res.json();
    assert.equal(errBody.error.code, 'INVALID_PID');
  } finally {
    await new Promise(r => server.close(r));
  }
});

// 3. Safety mode state changes & blocklist validation
test('Safety settings blocklist prevents port kill actions', async () => {
  const baseDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ports-mcp-robust-config-'));
  const configPath = path.join(baseDir, 'config.json');
  
  try {
    const config = new SafetyConfig({ configPath });
    config.setMode('blocklist');
    config.addToBlocklist(8080);
    
    const safetyLayer = new SafetyLayer({ config });
    
    const runner = {
      execFile: async () => ({ stdout: '' })
    };
    
    const service = createPortService({
      runner,
      safetyLayer,
      listPorts: async () => [{ port: 8080, pid: 9876, processName: 'node', user: 'yoni', type: 'IPv4', protocol: 'TCP', address: '*:8080', commandLine: 'node app.js' }]
    });
    
    await assert.rejects(
      async () => {
        await service.killProcessOnPort({ port: 8080, pid: 9876, confirm: true });
      },
      (err) => {
        assert.equal(err.code, 'SAFETY_BLOCKLIST');
        assert.equal(err.status, 403);
        return true;
      }
    );
  } finally {
    await fs.rm(baseDir, { recursive: true, force: true });
  }
});

// 4. Rate limiting alerts on status
test('Safety layer warns when rate limit capacity is highly loaded', async () => {
  const baseDir = path.join(os.tmpdir(), `ports-mcp-rl-${Date.now()}`);
  const config = new SafetyConfig({ configPath: path.join(baseDir, 'config.json') });
  config.setMode('allowlist');
  
  const safetyLayer = new SafetyLayer({ config });
  // Artificially trigger rate limiter operations close to the limit
  // Allowlist mode rate limit defaults to 30 per minute
  for (let i = 0; i < 28; i++) {
    safetyLayer._rateLimiter.record();
  }
  
  const { createAgentTools } = require('../src/mcp-tools');
  const tools = createAgentTools({ service: {}, safetyLayer });
  const result = await tools.getSafetyStatus();
  
  assert.equal(result.data.rateLimit.activeOpsInWindow, 28);
  assert.ok(result.warnings.some(w => w.includes('Rate limit approaching')));
});
