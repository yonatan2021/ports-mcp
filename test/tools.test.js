const test = require('node:test');
const assert = require('node:assert/strict');

const { SafetyConfig } = require('../src/config');
const { SafetyLayer } = require('../src/safety');
const { createPortService, PortManagerError } = require('../src/port-service');
const { createAgentTools } = require('../src/mcp-tools');
const { createMcpServer } = require('../src/mcp-server');


// ======================================================================
// Fixtures
// ======================================================================

const PORT_INFO_3000 = {
  port: 3000,
  pid: 12345,
  processName: 'node',
  user: 'yoni',
  type: 'IPv6',
  protocol: 'TCP',
  address: '*:3000',
  commandLine: 'node server.js',
};

const PORT_INFO_80 = {
  port: 80,
  pid: 22222,
  processName: 'httpd',
  user: 'root',
  type: 'IPv4',
  protocol: 'TCP',
  address: '127.0.0.1:80',
  commandLine: '/usr/sbin/httpd',
};

// ======================================================================
// verify_process_owner
// ======================================================================

test('verify_process_owner returns owner info for matching port+pid', async () => {
  const tools = createAgentTools({
    service: createPortService({
      listPorts: async () => [PORT_INFO_3000],
    }),
  });

  const result = await tools.verifyProcessOwner({ port: 3000, pid: 12345 });

  assert.equal(result.ok, true);
  assert.equal(result.data.owner, 'yoni');
  assert.equal(result.data.port, 3000);
  assert.equal(result.data.pid, 12345);
  assert.equal(result.data.processName, 'node');
});

test('verify_process_owner uses lsof user field when ps is unavailable', async () => {
  const tools = createAgentTools({
    service: createPortService({
      listPorts: async () => [PORT_INFO_3000],
    }),
    // No runner — falls back to lsof user field
  });

  const result = await tools.verifyProcessOwner({ port: 3000, pid: 12345 });

  assert.equal(result.ok, true);
  assert.equal(result.data.owner, 'yoni');
  assert.equal(result.data.verifiedBy, 'lsof');
});

test('verify_process_owner uses ps for double-check when runner is available', async () => {
  const runner = {
    execFile: async (file, args, opts) => {
      assert.equal(file, 'ps');
      assert.deepEqual(args, ['-p', '12345', '-o', 'user=']);
      return { stdout: 'yoni\n', stderr: '', exitCode: 0 };
    },
  };

  const tools = createAgentTools({
    service: createPortService({
      listPorts: async () => [PORT_INFO_3000],
    }),
    runner,
  });

  const result = await tools.verifyProcessOwner({ port: 3000, pid: 12345 });

  assert.equal(result.ok, true);
  assert.equal(result.data.owner, 'yoni');
  assert.equal(result.data.verifiedBy, 'ps');
});

test('verify_process_owner returns error for non-existent port', async () => {
  const tools = createAgentTools({
    service: createPortService({
      listPorts: async () => [PORT_INFO_3000],
    }),
  });

  const result = await tools.verifyProcessOwner({ port: 9999, pid: 99999 });

  assert.equal(result.ok, undefined);
  assert.equal(result.error, true);
  assert.equal(result.code, 'PORT_NOT_FOUND');
  assert.ok(result.safe_hint);
});

test('verify_process_owner returns error for mismatched pid', async () => {
  const tools = createAgentTools({
    service: createPortService({
      listPorts: async () => [PORT_INFO_3000],
    }),
  });

  const result = await tools.verifyProcessOwner({ port: 3000, pid: 99999 });

  assert.equal(result.ok, undefined);
  assert.equal(result.error, true);
  assert.equal(result.code, 'PORT_NOT_FOUND');
});

// ======================================================================
// get_process_details
// ======================================================================

test('get_process_details returns full process info', async () => {
  const tools = createAgentTools({
    service: createPortService({
      listPorts: async () => [PORT_INFO_3000],
    }),
  });

  const result = await tools.getProcessDetails({ port: 3000 });

  assert.equal(result.ok, true);
  assert.equal(result.data.port, 3000);
  assert.equal(result.data.pid, 12345);
  assert.equal(result.data.processName, 'node');
  assert.equal(result.data.user, 'yoni');
  assert.equal(result.data.commandLine, 'node server.js');
  assert.equal(result.data.protocol, 'TCP');
  assert.equal(result.data.address, '*:3000');
  assert.equal(result.data.type, 'IPv6');
});

test('get_process_details enriches with ps uptime and ppid when runner is available', async () => {
  const runner = {
    execFile: async (file, args, opts) => {
      assert.equal(file, 'ps');
      // Should request pid,ppid,user,comm,etime,args
      assert.ok(args.includes('-o'));
      const fields = args[args.indexOf('-o') + 1];
      assert.equal(fields, 'pid,ppid,user,comm,etime,args');
      return {
        stdout: '  PID  PPID USER  COMM  ELAPSED  ARGS\n12345  5678 yoni  node  01:23:45 node server.js\n',
        stderr: '',
        exitCode: 0,
      };
    },
  };

  const tools = createAgentTools({
    service: createPortService({
      listPorts: async () => [PORT_INFO_3000],
    }),
    runner,
  });

  const result = await tools.getProcessDetails({ port: 3000 });

  assert.equal(result.ok, true);
  assert.equal(result.data.ppid, 5678);
  assert.equal(result.data.uptime, '01:23:45');
  assert.equal(result.data.pid, 12345);
});

test('get_process_details handles ps failure gracefully', async () => {
  const runner = {
    execFile: async () => {
      throw new Error('ps failed');
    },
  };

  const tools = createAgentTools({
    service: createPortService({
      listPorts: async () => [PORT_INFO_3000],
    }),
    runner,
  });

  const result = await tools.getProcessDetails({ port: 3000 });

  assert.equal(result.ok, true);
  assert.equal(result.data.port, 3000);
  // Should have basic info even without ps enrichment
  assert.equal(result.data.pid, 12345);
  assert.equal(result.data.uptime, null);
  assert.equal(result.data.ppid, null);
});

test('get_process_details returns error for non-existent port', async () => {
  const tools = createAgentTools({
    service: createPortService({
      listPorts: async () => [PORT_INFO_3000],
    }),
  });

  const result = await tools.getProcessDetails({ port: 9999 });

  assert.equal(result.error, true);
  assert.equal(result.code, 'PORT_NOT_FOUND');
});

// ======================================================================
// safe_kill_process
// ======================================================================

test('safe_kill_process dry-runs by default and returns structured response', async () => {
  const config = new SafetyConfig({ mode: 'allowlist', allowlist: [3000], verifyOwner: false });
  const safetyLayer = new SafetyLayer({ config, currentUser: 'yoni' });

  const tools = createAgentTools({
    service: createPortService({
      listPorts: async () => [PORT_INFO_3000],
      killFn: () => { throw new Error('must not be called'); },
      safetyLayer,
    }),
    safetyLayer,
  });

  const result = await tools.safeKillProcess({ port: 3000, pid: 12345 });

  assert.equal(result.ok, true);
  assert.equal(result.data.dryRun, true);
  assert.equal(result.data.signalSent, null);
  // Should include warning about dry-run
  assert.ok(result.warnings.length > 0);
  assert.ok(result.warnings[0].includes('Dry-run'));
});

test('safe_kill_process sends SIGTERM with confirm=true when safety checks pass', async () => {
  const signals = [];
  const config = new SafetyConfig({ mode: 'allowlist', allowlist: [3000], verifyOwner: false });
  const safetyLayer = new SafetyLayer({ config, currentUser: 'yoni' });

  const tools = createAgentTools({
    service: createPortService({
      listPorts: async () => [PORT_INFO_3000],
      killFn: (pid, signal) => signals.push([pid, signal]),
      safetyLayer,
    }),
    safetyLayer,
  });

  const result = await tools.safeKillProcess({ port: 3000, pid: 12345, confirm: true });

  assert.equal(result.ok, true);
  assert.equal(result.data.dryRun, false);
  assert.equal(result.data.signalSent, 'SIGTERM');
  assert.deepEqual(signals, [[12345, 'SIGTERM']]);
});

test('safe_kill_process blocked by read-only mode', async () => {
  const config = new SafetyConfig({ mode: 'read-only' });
  const safetyLayer = new SafetyLayer({ config, currentUser: 'yoni' });

  const tools = createAgentTools({
    service: createPortService({
      listPorts: async () => [PORT_INFO_3000],
      killFn: () => { throw new Error('must not be called'); },
      safetyLayer,
    }),
    safetyLayer,
  });

  const result = await tools.safeKillProcess({ port: 3000, pid: 12345, confirm: true });

  assert.equal(result.ok, undefined);
  assert.equal(result.error, true);
  assert.equal(result.code, 'SAFETY_MODE');
  assert.ok(result.safe_hint);
});

test('safe_kill_process blocked for system process (launchd)', async () => {
  const config = new SafetyConfig({ mode: 'allowlist', allowlist: [80], verifyOwner: false });
  const safetyLayer = new SafetyLayer({ config, currentUser: 'yoni' });

  const tools = createAgentTools({
    service: createPortService({
      listPorts: async () => [{
        port: 80, pid: 1, processName: 'launchd', user: 'root',
        type: 'IPv4', protocol: 'TCP', address: '127.0.0.1:80', commandLine: 'launchd',
      }],
      killFn: () => { throw new Error('must not be called'); },
      safetyLayer,
    }),
    safetyLayer,
  });

  const result = await tools.safeKillProcess({ port: 80, pid: 1, confirm: true });

  assert.equal(result.error, true);
  assert.ok(result.code.startsWith('SAFETY_'));
  assert.ok(result.safe_hint);
});

test('safe_kill_process returns error for non-existent port', async () => {
  const tools = createAgentTools({
    service: createPortService({
      listPorts: async () => [PORT_INFO_3000],
    }),
  });

  const result = await tools.safeKillProcess({ port: 9999, pid: 99999 });

  assert.equal(result.error, true);
  assert.equal(result.code, 'PORT_NOT_FOUND');
});

// ======================================================================
// safe_restart_process (intentionally disabled)
// ======================================================================

test('safe_restart_process always returns error (intentionally disabled)', async () => {
  const tools = createAgentTools({
    service: createPortService({
      listPorts: async () => [PORT_INFO_3000],
    }),
  });

  const result = await tools.safeRestartProcess({ port: 3000, pid: 12345 });

  assert.equal(result.error, true);
  assert.equal(result.code, 'RESTART_NOT_IMPLEMENTED');
  assert.ok(result.safe_hint);
  assert.ok(result.safe_hint.includes('command allowlist'));
});

// ======================================================================
// get_safety_status
// ======================================================================

test('get_safety_status returns structured safety state', async () => {
  const config = new SafetyConfig({ mode: 'allowlist', allowlist: [3000, 8080] });
  const safetyLayer = new SafetyLayer({ config, currentUser: 'yoni' });

  const tools = createAgentTools({
    service: createPortService(),
    safetyLayer,
    runner: null,
  });

  const result = await tools.getSafetyStatus();

  assert.equal(result.ok, true);
  assert.equal(result.data.mode, 'allowlist');
  assert.equal(result.data.currentUser, 'yoni');
  assert.equal(result.data.verifyOwner, true);
  assert.ok(Array.isArray(result.data.allowlist));
  assert.ok(result.data.allowlist.includes(3000));
  assert.ok(result.data.allowlist.includes(8080));
  assert.equal(typeof result.data.blocklistCount, 'number');
  assert.equal(typeof result.data.processBlocklistCount, 'number');
  assert.ok(result.data.rateLimit);
  assert.equal(result.data.rateLimit.maxPerMinute, 5);
  assert.ok(result.data.cooldown);
  assert.equal(result.data.cooldown.cooldownMs, 3000);
});

test('get_safety_status warns in read-only mode', async () => {
  const config = new SafetyConfig({ mode: 'read-only' });
  const safetyLayer = new SafetyLayer({ config, currentUser: 'yoni' });

  const tools = createAgentTools({
    service: createPortService(),
    safetyLayer,
  });

  const result = await tools.getSafetyStatus();

  assert.equal(result.ok, true);
  assert.equal(result.data.mode, 'read-only');
  assert.ok(result.warnings.length > 0);
  assert.ok(result.warnings[0].includes('read-only'));
});

test('get_safety_status returns warnings when rate limit is near capacity', async () => {
  const config = new SafetyConfig({ mode: 'allowlist', allowlist: [3000], verifyOwner: false, maxOpsPerMinute: 5 });
  const safetyLayer = new SafetyLayer({ config, currentUser: 'yoni' });

  // Fill 4 of 5 slots (80%)
  safetyLayer._rateLimiter.record();
  safetyLayer._rateLimiter.record();
  safetyLayer._rateLimiter.record();
  safetyLayer._rateLimiter.record();

  const tools = createAgentTools({
    service: createPortService(),
    safetyLayer,
  });

  const result = await tools.getSafetyStatus();

  assert.equal(result.ok, true);
  assert.equal(result.data.rateLimit.activeOpsInWindow, 4);
  // Should warn when >=80% of capacity used
  const rateWarnings = result.warnings.filter((w) => w.includes('Rate limit'));
  assert.ok(rateWarnings.length > 0);
});

test('get_safety_status works without safety layer', async () => {
  const tools = createAgentTools({
    service: createPortService(),
    safetyLayer: null,
  });

  const result = await tools.getSafetyStatus();

  assert.equal(result.ok, true);
  assert.equal(result.data.mode, 'none');
  const warnings = result.warnings.filter((w) => w.includes('No safety layer'));
  assert.ok(warnings.length > 0);
});

// ======================================================================
// Error handling: structured error format
// ======================================================================

test('all error responses have safe_hint', async () => {
  const tools = createAgentTools({
    service: createPortService({
      listPorts: async () => [PORT_INFO_3000],
    }),
  });

  const errorResults = await Promise.all([
    tools.verifyProcessOwner({ port: 9999, pid: 99999 }),
    tools.getProcessDetails({ port: 9999 }),
    tools.safeKillProcess({ port: 9999, pid: 99999 }),
    tools.safeRestartProcess({ port: 3000, pid: 12345 }),
  ]);

  for (const result of errorResults) {
    assert.equal(result.error, true, `expected error response`);
    assert.ok(result.code, `expected error code`);
    assert.ok(result.message, `expected error message`);
    assert.ok(result.safe_hint, `expected safe_hint. tool: code=${result.code}`);
    // safe_hint should be a useful string, not empty
    assert.ok(result.safe_hint.length > 10);
  }
});

// ======================================================================
// Missing dependency
// ======================================================================

test('createAgentTools throws without service', () => {
  assert.throws(
    () => createAgentTools({}),
    /service is required/
  );
});

// ======================================================================
// Cache cleaning tools (list_caches, clean_cache)
// ======================================================================

test('list_caches tool returns cache details from service', async () => {
  const service = {
    getCacheDetails: async () => [
      { name: 'npm Cache', path: '/Users/yoni/.npm', bytes: 1000, category: 'SAFE_TO_CLEAR', description: 'npm cache' }
    ]
  };
  const tools = createAgentTools({ service });
  const result = await tools.listCaches();
  assert.equal(result.ok, true);
  assert.deepEqual(result.data, [
    { name: 'npm Cache', path: '/Users/yoni/.npm', bytes: 1000, category: 'SAFE_TO_CLEAR', description: 'npm cache' }
  ]);
});

test('clean_cache tool trashes path via service', async () => {
  const service = {
    trashCachePath: async ({ path, confirm }) => {
      assert.equal(path, '/Users/yoni/.npm');
      assert.equal(confirm, true);
      return { ok: true, trashed: true, path };
    }
  };
  const tools = createAgentTools({ service });
  const result = await tools.cleanCache({ path: '/Users/yoni/.npm', confirm: true });
  assert.equal(result.ok, true);
  assert.deepEqual(result.data, { ok: true, trashed: true, path: '/Users/yoni/.npm' });
});

test('MCP Server registers list_caches and clean_cache', async () => {
  const service = {
    getCacheDetails: async () => [],
    trashCachePath: async () => ({})
  };
  const server = createMcpServer({ service });
  
  assert.ok(server._registeredTools.list_caches, 'list_caches tool should be registered');
  assert.ok(server._registeredTools.clean_cache, 'clean_cache tool should be registered');
});

test('list_caches tool handler returns structured caches', async () => {
  const service = {
    getCacheDetails: async () => [
      { name: 'npm Cache', path: '/Users/yoni/.npm', bytes: 1000, category: 'SAFE_TO_CLEAR', description: 'npm cache' }
    ]
  };
  const server = createMcpServer({ service });
  const tool = server._registeredTools.list_caches;
  
  const result = await tool.handler();
  assert.deepEqual(JSON.parse(result.content[0].text), [
    { name: 'npm Cache', path: '/Users/yoni/.npm', bytes: 1000, category: 'SAFE_TO_CLEAR', description: 'npm cache' }
  ]);
});

test('clean_cache tool handler trashes cache path', async () => {
  let trashedPath = null;
  let isConfirmed = false;
  const service = {
    trashCachePath: async ({ path, confirm }) => {
      trashedPath = path;
      isConfirmed = confirm;
      return { ok: true, trashed: true, path };
    }
  };
  const server = createMcpServer({ service });
  const tool = server._registeredTools.clean_cache;
  
  const result = await tool.handler({ path: '/Users/yoni/.npm', confirm: true });
  assert.equal(trashedPath, '/Users/yoni/.npm');
  assert.equal(isConfirmed, true);
  assert.deepEqual(JSON.parse(result.content[0].text), { ok: true, trashed: true, path: '/Users/yoni/.npm' });
});

