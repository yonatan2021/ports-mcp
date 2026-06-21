const test = require('node:test');
const assert = require('node:assert/strict');

const { SafetyConfig } = require('../src/config');
const { SafetyLayer, SafetyError, SlidingWindowRateLimiter, CooldownTracker } = require('../src/safety');
const { createPortService, PortManagerError } = require('../src/port-service');

// ======================================================================
// SafetyConfig
// ======================================================================

test('SafetyConfig defaults to read-only mode with system port blocklist', () => {
  const config = new SafetyConfig();
  assert.equal(config.mode, 'read-only');
  assert.ok(config.blocklist.has(80));   // HTTP
  assert.ok(config.blocklist.has(443));  // HTTPS
  assert.ok(config.blocklist.has(22));   // SSH
  assert.ok(config.blocklist.has(0));    // edge
  assert.equal(config.blocklist.has(1024), false); // 1024 is not a system port
  assert.equal(config.allowlist.size, 0);
  assert.equal(config.maxOpsPerMinute, 5);
  assert.equal(config.cooldownMs, 3000);
  assert.equal(config.verifyOwner, true);
});

test('SafetyConfig loads allowlist from env var', () => {
  const original = process.env.PORTS_MCP_ALLOWLIST;
  try {
    process.env.PORTS_MCP_ALLOWLIST = '3000,8080,9090';
    const config = new SafetyConfig();
    assert.ok(config.allowlist.has(3000));
    assert.ok(config.allowlist.has(8080));
    assert.ok(config.allowlist.has(9090));
    assert.equal(config.allowlist.has(80), false);
  } finally {
    process.env.PORTS_MCP_ALLOWLIST = original;
  }
});

test('SafetyConfig loads blocklist from env var', () => {
  const original = process.env.PORTS_MCP_BLOCKLIST;
  try {
    process.env.PORTS_MCP_BLOCKLIST = '3000,8080';
    const config = new SafetyConfig();
    assert.ok(config.blocklist.has(3000));
    assert.ok(config.blocklist.has(8080));
    assert.equal(config.blocklist.has(80), false); // env overrides default
  } finally {
    process.env.PORTS_MCP_BLOCKLIST = original;
  }
});

test('SafetyConfig loads mode from env var', () => {
  const original = process.env.PORTS_MCP_MODE;
  try {
    process.env.PORTS_MCP_MODE = 'allowlist';
    const config = new SafetyConfig();
    assert.equal(config.mode, 'allowlist');
  } finally {
    process.env.PORTS_MCP_MODE = original;
  }
});

test('SafetyConfig falls back to read-only on invalid mode', () => {
  const original = process.env.PORTS_MCP_MODE;
  try {
    process.env.PORTS_MCP_MODE = 'invalid';
    const config = new SafetyConfig();
    assert.equal(config.mode, 'read-only');
  } finally {
    process.env.PORTS_MCP_MODE = original;
  }
});

test('SafetyConfig options override env vars', () => {
  const original = process.env.PORTS_MCP_MODE;
  try {
    process.env.PORTS_MCP_MODE = 'read-only';
    const config = new SafetyConfig({ mode: 'allowlist', allowlist: [3000, 8080], verifyOwner: false });
    assert.equal(config.mode, 'allowlist');
    assert.ok(config.allowlist.has(3000));
    assert.equal(config.allowlist.has(9999), false);
    assert.equal(config.verifyOwner, false);
  } finally {
    process.env.PORTS_MCP_MODE = original;
  }
});

test('SafetyConfig allows runtime mode switching', () => {
  const config = new SafetyConfig();
  assert.equal(config.mode, 'read-only');
  config.setMode('allowlist');
  assert.equal(config.mode, 'allowlist');
  config.setMode('blocklist');
  assert.equal(config.mode, 'blocklist');
  assert.throws(() => config.setMode('nope'), /Invalid mode/);
});

test('SafetyConfig runtime allowlist mutations', () => {
  const config = new SafetyConfig();
  assert.equal(config.allowlist.size, 0);

  config.addToAllowlist(3000);
  assert.ok(config.allowlist.has(3000));

  config.removeFromAllowlist(3000);
  assert.equal(config.allowlist.has(3000), false);

  config.setAllowlist([8080, 9090]);
  assert.ok(config.allowlist.has(8080));
  assert.ok(config.allowlist.has(9090));
  assert.equal(config.allowlist.size, 2);
});

test('SafetyConfig runtime blocklist mutations', () => {
  const config = new SafetyConfig();
  config.setBlocklist([3000, 4000]);
  assert.ok(config.blocklist.has(3000));
  assert.ok(config.blocklist.has(4000));
  assert.equal(config.blocklist.has(80), false);

  config.addToBlocklist(5000);
  assert.ok(config.blocklist.has(5000));

  config.removeFromBlocklist(3000);
  assert.equal(config.blocklist.has(3000), false);
});

test('SafetyConfig toJSON returns sorted arrays', () => {
  const config = new SafetyConfig();
  config.setAllowlist([9090, 3000, 8080]);
  const json = config.toJSON();
  assert.deepEqual(json.allowlist, [3000, 8080, 9090]);
  assert.equal(typeof json.processBlocklistCount, 'number');
  assert.ok(json.processBlocklistCount > 0);
  assert.equal(json.mode, 'read-only');
});

// ======================================================================
// SlidingWindowRateLimiter
// ======================================================================

test('SlidingWindowRateLimiter allows operations within limit', () => {
  const limiter = new SlidingWindowRateLimiter({ maxPerWindow: 3, windowMs: 60_000 });
  assert.deepEqual(limiter.check(), { allowed: true, remaining: 3, resetMs: 0 });
  limiter.record();
  assert.deepEqual(limiter.check(), { allowed: true, remaining: 2, resetMs: 0 });
  limiter.record();
  assert.deepEqual(limiter.check(), { allowed: true, remaining: 1, resetMs: 0 });
  limiter.record();
  const check = limiter.check();
  assert.equal(check.allowed, false);
  assert.equal(check.remaining, 0);
  assert.ok(check.resetMs > 0);
});

test('SlidingWindowRateLimiter prunes expired entries', () => {
  const limiter = new SlidingWindowRateLimiter({ maxPerWindow: 2, windowMs: 50 });
  limiter.record();
  limiter.record();
  assert.equal(limiter.check().allowed, false);
  // Wait for window to pass
  return new Promise((resolve) => {
    setTimeout(() => {
      assert.equal(limiter.check().allowed, true);
      resolve();
    }, 60);
  });
});

test('SlidingWindowRateLimiter reset clears all timestamps', () => {
  const limiter = new SlidingWindowRateLimiter({ maxPerWindow: 2, windowMs: 60_000 });
  limiter.record();
  limiter.record();
  assert.equal(limiter.check().allowed, false);
  limiter.reset();
  assert.deepEqual(limiter.check(), { allowed: true, remaining: 2, resetMs: 0 });
});

// ======================================================================
// CooldownTracker
// ======================================================================

test('CooldownTracker allows first operation immediately', () => {
  const cooldown = new CooldownTracker({ minIntervalMs: 1000 });
  assert.deepEqual(cooldown.check(), { allowed: true, waitMs: 0 });
});

test('CooldownTracker blocks operations within cooldown window', () => {
  const cooldown = new CooldownTracker({ minIntervalMs: 5000 });
  cooldown.record();
  const check = cooldown.check();
  assert.equal(check.allowed, false);
  assert.ok(check.waitMs > 0);
  assert.ok(check.waitMs <= 5000);
});

test('CooldownTracker allows after waiting', () => {
  const cooldown = new CooldownTracker({ minIntervalMs: 30 });
  cooldown.record();
  return new Promise((resolve) => {
    setTimeout(() => {
      assert.deepEqual(cooldown.check(), { allowed: true, waitMs: 0 });
      resolve();
    }, 40);
  });
});

// ======================================================================
// SafetyLayer — Mode Checks
// ======================================================================

test('SafetyLayer blocks all destructive ops in read-only mode', async () => {
  const config = new SafetyConfig({ mode: 'read-only' });
  const layer = new SafetyLayer({ config, currentUser: 'yoni' });
  const target = { port: 3000, pid: 12345, processName: 'node', user: 'yoni' };

  const result = await layer.checkDestructive(target);
  assert.equal(result.ok, false);
  assert.equal(result.check, 'mode');
  assert.ok(result.reason.includes('read-only'));
});

test('SafetyLayer allows ops in allowlist mode for allowed ports', async () => {
  const config = new SafetyConfig({ mode: 'allowlist', allowlist: [3000], verifyOwner: false });
  const layer = new SafetyLayer({ config, currentUser: 'yoni' });
  const target = { port: 3000, pid: 12345, processName: 'node', user: 'yoni' };

  const result = await layer.checkDestructive(target);
  assert.equal(result.ok, true);
});

test('SafetyLayer blocks ops in allowlist mode for ports not in the list', async () => {
  const config = new SafetyConfig({ mode: 'allowlist', allowlist: [3000] });
  const layer = new SafetyLayer({ config, currentUser: 'yoni' });
  const target = { port: 8080, pid: 12345, processName: 'node', user: 'yoni' };

  const result = await layer.checkDestructive(target);
  assert.equal(result.ok, false);
  assert.equal(result.check, 'allowlist');
});

test('SafetyLayer blocks ops in blocklist mode for blocked ports', async () => {
  const config = new SafetyConfig({ mode: 'blocklist', blocklist: [80], verifyOwner: false });
  const layer = new SafetyLayer({ config, currentUser: 'yoni' });
  const target = { port: 80, pid: 12345, processName: 'httpd', user: 'yoni' };

  const result = await layer.checkDestructive(target);
  assert.equal(result.ok, false);
  assert.equal(result.check, 'blocklist');
});

test('SafetyLayer allows ops in blocklist mode for non-blocked ports', async () => {
  const config = new SafetyConfig({ mode: 'blocklist', blocklist: [80], verifyOwner: false });
  const layer = new SafetyLayer({ config, currentUser: 'yoni' });
  const target = { port: 3000, pid: 12345, processName: 'node', user: 'yoni' };

  const result = await layer.checkDestructive(target);
  assert.equal(result.ok, true);
});

// ======================================================================
// SafetyLayer — System Process Protection
// ======================================================================

test('SafetyLayer blocks system processes by name (launchd)', async () => {
  const config = new SafetyConfig({ mode: 'allowlist', allowlist: [3000], verifyOwner: false });
  const layer = new SafetyLayer({ config, currentUser: 'yoni' });
  const target = { port: 3000, pid: 1, processName: 'launchd', user: 'root' };

  const result = await layer.checkDestructive(target);
  assert.equal(result.ok, false);
  assert.equal(result.check, 'process_name_blocklist');
});

test('SafetyLayer blocks system processes by name (systemd)', async () => {
  const config = new SafetyConfig({ mode: 'allowlist', allowlist: [3000], verifyOwner: false });
  const layer = new SafetyLayer({ config, currentUser: 'yoni' });
  const target = { port: 3000, pid: 1, processName: 'systemd', user: 'yoni' };

  const result = await layer.checkDestructive(target);
  assert.equal(result.ok, false);
  assert.equal(result.check, 'process_name_blocklist');
});

test('SafetyLayer blocks case-insensitive process name matches', async () => {
  const config = new SafetyConfig({ mode: 'allowlist', allowlist: [3000], verifyOwner: false });
  const layer = new SafetyLayer({ config, currentUser: 'yoni' });
  const target = { port: 3000, pid: 1, processName: 'LaunchD', user: 'yoni' };

  const result = await layer.checkDestructive(target);
  assert.equal(result.ok, false);
  assert.equal(result.check, 'process_name_blocklist');
});

// ======================================================================
// SafetyLayer — System Port Protection
// ======================================================================

test('SafetyLayer blocks system ports (<1024) by default', async () => {
  // Use blocklist mode where port 80 is NOT in the blocklist, so system port check fires
  const config = new SafetyConfig({ mode: 'blocklist', blocklist: [8080, 9090], verifyOwner: false });
  const layer = new SafetyLayer({ config, currentUser: 'yoni' });
  const target = { port: 80, pid: 22222, processName: 'httpd', user: 'yoni' };

  const result = await layer.checkDestructive(target);
  assert.equal(result.ok, false);
  assert.equal(result.check, 'system_port');
});

test('SafetyLayer allows system ports with allowSystemPort=true', async () => {
  const config = new SafetyConfig({ mode: 'allowlist', allowlist: [80], verifyOwner: false });
  const layer = new SafetyLayer({ config, currentUser: 'yoni' });
  const target = { port: 80, pid: 22222, processName: 'httpd', user: 'yoni' };

  const result = await layer.checkDestructive(target, { allowSystemPort: true });
  assert.equal(result.ok, true);
});

test('SafetyLayer allows system ports that are explicitly in the allowlist', async () => {
  const config = new SafetyConfig({ mode: 'allowlist', allowlist: [80], verifyOwner: false });
  const layer = new SafetyLayer({ config, currentUser: 'yoni' });

  // Add 80 to allowlist as explicit override
  config.addToAllowlist(80);

  const target = { port: 80, pid: 22222, processName: 'httpd', user: 'yoni' };
  const result = await layer.checkDestructive(target);
  assert.equal(result.ok, true);
});

// ======================================================================
// SafetyLayer — Owner Verification
// ======================================================================

test('SafetyLayer blocks processes owned by another user', async () => {
  const config = new SafetyConfig({ mode: 'allowlist', allowlist: [80], verifyOwner: true });
  const layer = new SafetyLayer({ config, currentUser: 'yoni' });
  const target = { port: 80, pid: 22222, processName: 'httpd', user: 'root' };

  const result = await layer.checkDestructive(target);
  assert.equal(result.ok, false);
  assert.equal(result.check, 'owner');
});

test('SafetyLayer allows processes owned by current user', async () => {
  const config = new SafetyConfig({ mode: 'allowlist', allowlist: [3000], verifyOwner: true });
  const layer = new SafetyLayer({ config, currentUser: 'yoni' });
  const target = { port: 3000, pid: 12345, processName: 'node', user: 'yoni' };

  const result = await layer.checkDestructive(target);
  assert.equal(result.ok, true);
});

// ======================================================================
// SafetyLayer — Rate Limiting
// ======================================================================

test('SafetyLayer rate limits after exceeding max per minute', async () => {
  const config = new SafetyConfig({ mode: 'allowlist', allowlist: [3000, 3001, 3002], verifyOwner: false, maxOpsPerMinute: 2, cooldownMs: 0 });
  const layer = new SafetyLayer({ config, currentUser: 'yoni' });
  const targets = [
    { port: 3000, pid: 100, processName: 'node', user: 'yoni' },
    { port: 3001, pid: 101, processName: 'node', user: 'yoni' },
  ];

  const r1 = await layer.checkDestructive(targets[0]);
  assert.equal(r1.ok, true);

  const r2 = await layer.checkDestructive(targets[1]);
  assert.equal(r2.ok, true);

  const r3 = await layer.checkDestructive(targets[0]);
  assert.equal(r3.ok, false);
  assert.equal(r3.check, 'rate_limit');
});

test('SafetyLayer enforces cooldown between operations', async () => {
  const config = new SafetyConfig({ mode: 'allowlist', allowlist: [3000, 3001], verifyOwner: false, cooldownMs: 5000 });
  const layer = new SafetyLayer({ config, currentUser: 'yoni' });

  const r1 = await layer.checkDestructive({ port: 3000, pid: 100, processName: 'node', user: 'yoni' });
  assert.equal(r1.ok, true);

  const r2 = await layer.checkDestructive({ port: 3001, pid: 101, processName: 'node', user: 'yoni' });
  assert.equal(r2.ok, false);
  assert.equal(r2.check, 'cooldown');
});

test('Rate limiter reset on config change via refreshRateLimiters', () => {
  const config = new SafetyConfig({ maxOpsPerMinute: 2 });
  const layer = new SafetyLayer({ config, currentUser: 'yoni' });

  // Before refresh, old settings are cached
  layer._rateLimiter.record();
  layer._rateLimiter.record();
  assert.equal(layer._rateLimiter.check().allowed, false);

  // After refresh, counter is reset
  layer.refreshRateLimiters();
  assert.equal(layer._rateLimiter.check().allowed, true);
});

// ======================================================================
// SafetyLayer — MCP tool integration tests
// ======================================================================

test('SafetyLayer getStatus returns structured config snapshot', () => {
  const config = new SafetyConfig({ mode: 'allowlist', allowlist: [3000] });
  const layer = new SafetyLayer({ config, currentUser: 'yoni' });
  const status = layer.getStatus();

  assert.equal(status.mode, 'allowlist');
  assert.ok(Array.isArray(status.allowlist));
  assert.equal(typeof status.processBlocklistCount, 'number');
  assert.equal(typeof status.rateLimit.maxPerMinute, 'number');
  assert.equal(typeof status.cooldown.cooldownMs, 'number');
  assert.equal(status.currentUser, 'yoni');
  assert.ok(typeof status.selfPid, 'number');
});

// ======================================================================
// Integration: SafetyLayer + PortService
// ======================================================================

test('killProcessOnPort rejects in read-only mode via safety layer', async () => {
  const config = new SafetyConfig({ mode: 'read-only' });
  const safetyLayer = new SafetyLayer({ config, currentUser: 'yoni' });
  const service = createPortService({
    listPorts: async () => [{ port: 3000, pid: 12345, processName: 'node', user: 'yoni', type: 'IPv6', protocol: 'TCP', address: '*:3000', commandLine: 'node server.js' }],
    killFn: () => { throw new Error('must not be called'); },
    safetyLayer,
  });

  await assert.rejects(
    () => service.killProcessOnPort({ port: 3000, pid: 12345, confirm: true }),
    (err) => err instanceof PortManagerError && err.code === 'SAFETY_MODE'
  );
});

test('killProcessOnPort blocks system processes by name via safety layer', async () => {
  const config = new SafetyConfig({ mode: 'allowlist', allowlist: [80] });
  const safetyLayer = new SafetyLayer({ config, currentUser: 'yoni' });
  const service = createPortService({
    listPorts: async () => [{ port: 80, pid: 22222, processName: 'launchd', user: 'root', type: 'IPv4', protocol: 'TCP', address: '*:80', commandLine: 'launchd' }],
    killFn: () => { throw new Error('must not be called'); },
    safetyLayer,
  });

  await assert.rejects(
    () => service.killProcessOnPort({ port: 80, pid: 22222, confirm: true }),
    (err) => err instanceof PortManagerError && err.code.startsWith('SAFETY_')
  );
});

test('killProcessOnPort allows kill when all safety checks pass', async () => {
  const signals = [];
  const config = new SafetyConfig({ mode: 'allowlist', allowlist: [3000], verifyOwner: false });
  const safetyLayer = new SafetyLayer({ config, currentUser: 'yoni' });
  const service = createPortService({
    listPorts: async () => [{ port: 3000, pid: 12345, processName: 'node', user: 'yoni', type: 'IPv6', protocol: 'TCP', address: '*:3000', commandLine: 'node server.js' }],
    killFn: (pid, signal) => signals.push([pid, signal]),
    safetyLayer,
  });

  const result = await service.killProcessOnPort({ port: 3000, pid: 12345, confirm: true });
  assert.equal(result.signalSent, 'SIGTERM');
  assert.deepEqual(signals, [[12345, 'SIGTERM']]);
});

test('Integration: existing checks still work alongside safety layer', async () => {
  const config = new SafetyConfig({ mode: 'allowlist', allowlist: [9999], verifyOwner: false });
  const safetyLayer = new SafetyLayer({ config, selfPid: 777, selfPort: 9999 });
  const service = createPortService({
    selfPid: 777,
    selfPort: 9999,
    listPorts: async () => [{ port: 9999, pid: 777, processName: 'ports-mcp', user: 'yoni', type: 'IPv4', protocol: 'TCP', address: '127.0.0.1:9999', commandLine: 'node server.js' }],
    killFn: () => { throw new Error('must not be called'); },
    safetyLayer,
  });

  // Self-kill still blocked (existing check runs after safety)
  await assert.rejects(
    () => service.killProcessOnPort({ port: 9999, pid: 777, confirm: true }),
    (err) => err instanceof PortManagerError && err.code === 'REFUSE_SELF'
  );
});

test('Safety layer without safetyLayer in port-service works as before', async () => {
  // When no safetyLayer is passed, existing checks still work
  const signals = [];
  const service = createPortService({
    listPorts: async () => [{ port: 3000, pid: 12345, processName: 'node', user: 'yoni', type: 'IPv6', protocol: 'TCP', address: '*:3000', commandLine: 'node server.js' }],
    killFn: (pid, signal) => signals.push([pid, signal]),
  });

  const result = await service.killProcessOnPort({ port: 3000, pid: 12345, confirm: true, waitMs: 10 });
  assert.equal(result.signalSent, 'SIGTERM');
  assert.deepEqual(signals, [[12345, 'SIGTERM']]);
});

// ======================================================================
// SafetyLayer — Owner verification fallback (ps)
// ======================================================================

test('SafetyLayer verifies owner via ps fallback when user field is empty', async () => {
  const calls = [];
  const config = new SafetyConfig({ mode: 'allowlist', allowlist: [3000], verifyOwner: true });
  const layer = new SafetyLayer({
    config,
    currentUser: 'yoni',
    runner: {
      execFile: async (file, args) => {
        calls.push([file, args]);
        if (file === 'ps' && args[1] === '12345') return { stdout: 'yoni\n', stderr: '', exitCode: 0 };
        throw new Error(`unexpected: ${file} ${args.join(' ')}`);
      },
    },
  });
  const target = { port: 3000, pid: 12345, processName: 'node', user: 'yoni' };

  const result = await layer.checkDestructive(target);
  assert.equal(result.ok, true);
  assert.ok(calls.some(([file]) => file === 'ps'));
});

test('SafetyLayer blocks when ps shows different owner than current user', async () => {
  const config = new SafetyConfig({ mode: 'allowlist', allowlist: [3000], verifyOwner: true });
  const layer = new SafetyLayer({
    config,
    currentUser: 'yoni',
    runner: {
      execFile: async (file, args) => {
        if (file === 'ps' && args[1] === '12345') return { stdout: 'root\n', stderr: '', exitCode: 0 };
        throw new Error(`unexpected: ${file} ${args.join(' ')}`);
      },
    },
  });
  const target = { port: 3000, pid: 12345, processName: 'node', user: 'yoni' };

  const result = await layer.checkDestructive(target);
  assert.equal(result.ok, false);
  assert.equal(result.check, 'owner_verified');
});

test('SafetyLayer blocks destructive ops on processes flagged as isSystem', async () => {
  const config = new SafetyConfig({ mode: 'blocklist' });
  const layer = new SafetyLayer({ config, currentUser: 'yonig' });
  const target = { port: 7000, pid: 12345, processName: 'ControlCenter', user: 'yonig', isSystem: true };

  const result = await layer.checkDestructive(target);
  assert.equal(result.ok, false);
  assert.equal(result.check, 'system_process');
  assert.ok(result.reason.includes('system process'));
});

