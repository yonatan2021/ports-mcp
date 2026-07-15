const test = require('node:test');
const assert = require('node:assert/strict');

const {
  PortManagerError,
  parseLsofOutput,
  createPortService,
} = require('../src/port-service');

const LSOF_SAMPLE = `COMMAND   PID USER   FD   TYPE             DEVICE SIZE/OFF NODE NAME
node    12345 yoni   21u  IPv6 0xabc123456789      0t0  TCP *:3000 (LISTEN)
Control 22222 root   10u  IPv4 0xdef123456789      0t0  TCP 127.0.0.1:80 (LISTEN)
Python  33333 yoni    8u  IPv4 0xbeef12345678      0t0  TCP 127.0.0.1:54321 (LISTEN)
`;

test('parseLsofOutput returns listening ports with pid/process/user/protocol/address', () => {
  const ports = parseLsofOutput(LSOF_SAMPLE);

  assert.deepEqual(ports, [
    {
      port: 3000,
      pid: 12345,
      processName: 'node',
      user: 'yoni',
      type: 'IPv6',
      protocol: 'TCP',
      address: '*:3000',
    },
    {
      port: 80,
      pid: 22222,
      processName: 'Control',
      user: 'root',
      type: 'IPv4',
      protocol: 'TCP',
      address: '127.0.0.1:80',
    },
    {
      port: 54321,
      pid: 33333,
      processName: 'Python',
      user: 'yoni',
      type: 'IPv4',
      protocol: 'TCP',
      address: '127.0.0.1:54321',
    },
  ]);
});

test('listPorts uses execFile argv and enriches command lines without shell interpolation', async () => {
  const calls = [];
  const runner = {
    execFile: async (file, args) => {
      calls.push([file, args]);
      if (file === 'lsof') return { stdout: LSOF_SAMPLE, stderr: '', exitCode: 0 };
      if (file === 'ps' && args[1] === '12345') return { stdout: 'node server.js\n', stderr: '', exitCode: 0 };
      if (file === 'ps' && args[1] === '22222') return { stdout: '/usr/libexec/ControlCenter\n', stderr: '', exitCode: 0 };
      if (file === 'ps' && args[1] === '33333') return { stdout: 'python3 -m http.server 54321\n', stderr: '', exitCode: 0 };
      throw new Error(`unexpected call ${file} ${args.join(' ')}`);
    },
  };
  const service = createPortService({ runner });

  const ports = await service.listPorts();

  assert.equal(ports[0].commandLine, '/usr/libexec/ControlCenter');
  assert.equal(ports[1].commandLine, 'node server.js');
  assert.equal(ports[2].commandLine, 'python3 -m http.server 54321');
  assert.deepEqual(calls[0], ['lsof', ['-iTCP', '-sTCP:LISTEN', '-P', '-n']]);
  assert.ok(calls.every(([file]) => file !== 'sh' && file !== '/bin/sh'));
});

test('killProcessOnPort dry-runs by default and does not signal processes without confirm=true', async () => {
  const signals = [];
  const service = createPortService({
    listPorts: async () => [{ port: 3000, pid: 12345, processName: 'node', user: 'yoni', type: 'IPv6', protocol: 'TCP', address: '*:3000', commandLine: 'node server.js' }],
    killFn: (pid, signal) => signals.push([pid, signal]),
  });

  const result = await service.killProcessOnPort({ port: 3000, pid: 12345 });

  assert.equal(result.dryRun, true);
  assert.equal(result.wouldSignal, 'SIGTERM');
  assert.deepEqual(signals, []);
});

test('killProcessOnPort validates pid/port match before sending SIGTERM', async () => {
  const signals = [];
  const service = createPortService({
    listPorts: async () => [{ port: 3000, pid: 12345, processName: 'node', user: 'yoni', type: 'IPv6', protocol: 'TCP', address: '*:3000', commandLine: 'node server.js' }],
    killFn: (pid, signal) => signals.push([pid, signal]),
  });

  await assert.rejects(
    () => service.killProcessOnPort({ port: 3000, pid: 99999, confirm: true }),
    (err) => err instanceof PortManagerError && err.code === 'PORT_PID_MISMATCH'
  );
  assert.deepEqual(signals, []);

  const result = await service.killProcessOnPort({ port: 3000, pid: 12345, confirm: true });
  assert.equal(result.signalSent, 'SIGTERM');
  assert.deepEqual(signals, [[12345, 'SIGTERM']]);
});

test('killProcessOnPort refuses self and system ports unless explicitly allowed', async () => {
  const service = createPortService({
    selfPid: 777,
    selfPort: 9999,
    listPorts: async () => [
      { port: 9999, pid: 777, processName: 'ports-mcp', user: 'yoni', type: 'IPv4', protocol: 'TCP', address: '127.0.0.1:9999', commandLine: 'node server.js' },
      { port: 80, pid: 22222, processName: 'Control', user: 'root', type: 'IPv4', protocol: 'TCP', address: '127.0.0.1:80', commandLine: 'ControlCenter' },
    ],
    killFn: () => { throw new Error('must not be called'); },
  });

  await assert.rejects(
    () => service.killProcessOnPort({ port: 9999, pid: 777, confirm: true }),
    (err) => err instanceof PortManagerError && err.code === 'REFUSE_SELF'
  );

  await assert.rejects(
    () => service.killProcessOnPort({ port: 80, pid: 22222, confirm: true }),
    (err) => err instanceof PortManagerError && err.code === 'SYSTEM_PORT_REQUIRES_ALLOW'
  );
});

test('restartProcessOnPort is intentionally unavailable without an allowlisted restart implementation', async () => {
  const service = createPortService({ listPorts: async () => [] });

  await assert.rejects(
    () => service.restartProcessOnPort({ port: 3000, pid: 12345, commandLine: 'node server.js' }),
    (err) => err instanceof PortManagerError && err.code === 'RESTART_NOT_IMPLEMENTED'
  );
});

test('isSystemProcess correctly identifies system and user processes', () => {
  const { isSystemProcess } = require('../src/port-service');

  // 1. System user should be system process
  assert.equal(isSystemProcess({ user: 'root', processName: 'node', commandLine: 'node' }), true);
  assert.equal(isSystemProcess({ user: '_windowserver', processName: 'WindowServer', commandLine: 'WindowServer' }), true);

  // 2. System path should be system process
  assert.equal(isSystemProcess({ user: 'yonig', processName: 'rapportd', commandLine: '/usr/libexec/rapportd' }), true);
  assert.equal(isSystemProcess({ user: 'yonig', processName: 'launchd', commandLine: '/System/Library/CoreServices/launchd' }), true);

  // 3. System process name should be system process
  assert.equal(isSystemProcess({ user: 'yonig', processName: 'WindowServer', commandLine: 'WindowServer' }), true);

  // 4. Custom developer process should NOT be system process
  assert.equal(isSystemProcess({ user: 'yonig', processName: 'node', commandLine: 'node server.js' }), false);
  assert.equal(isSystemProcess({ user: 'yonig', processName: 'python3', commandLine: 'python3 -m http.server' }), false);
});

test('listPorts enriches results with isSystem', async () => {
  const service = createPortService({
    listPorts: async () => [
      { port: 3000, pid: 123, processName: 'node', user: 'yonig', type: 'IPv4', protocol: 'TCP', address: '*:3000', commandLine: 'node server.js' },
      { port: 7000, pid: 456, processName: 'ControlCenter', user: 'yonig', type: 'IPv4', protocol: 'TCP', address: '*:7000', commandLine: '/System/Library/CoreServices/ControlCenter.app/Contents/MacOS/ControlCenter' }
    ]
  });
  const ports = await service.listPorts();
  assert.equal(ports[0].isSystem, false);
  assert.equal(ports[1].isSystem, true);
  });

  test('getSystemUsage returns CPU and memory statistics', async () => {
    const service = createPortService();
  const usage = await service.getSystemUsage();
  assert.ok(typeof usage.cpu === 'number');
  assert.ok(typeof usage.memory.percentage === 'number');
  assert.ok(usage.memory.totalBytes > 0);
});

test('getSystemUsage uses macOS memory pressure instead of raw free memory', async () => {
  const calls = [];
  const runner = {
    execFile: async (file, args) => {
      calls.push([file, args]);
      assert.equal(file, 'memory_pressure');
      assert.deepEqual(args, ['-Q']);
      return {
        stdout: 'The system has 17179869184 (1048576 pages with a page size of 16384).\nSystem-wide memory free percentage: 58%\n',
        stderr: '',
        exitCode: 0,
      };
    }
  };
  const service = createPortService({ runner });

  const usage = await service.getSystemUsage();

  assert.equal(usage.memory.percentage, 42);
  assert.equal(usage.memory.usedBytes, Math.round(usage.memory.totalBytes * 0.42));
  assert.deepEqual(calls, [['memory_pressure', ['-Q']]]);
});

test('getSystemProcesses parses ps output correctly', async () => {
  const psStdout = ` %CPU   RSS STAT   PID USER COMM
 12.5 1048576 S   1234 yoni /Applications/Google Chrome.app/Contents/MacOS/Google Chrome
  0.0  51200 T   5678 yoni /usr/local/bin/node
  1.5 2048000 R      1 root /sbin/launchd
`;
  const runner = {
    execFile: async () => ({ stdout: psStdout, stderr: '', exitCode: 0 })
  };
  const service = createPortService({ runner, currentUser: 'yoni' });
  const list = await service.getSystemProcesses();

  assert.equal(list.length, 3);
  assert.equal(list[0].pid, 1234);
  assert.equal(list[0].processName, 'Google Chrome');
  assert.equal(list[0].cpu, 12.5);
  assert.equal(list[0].memoryMb, 1024.0);
  assert.equal(list[0].isSuspended, false);
  assert.equal(list[0].isSystem, false);

  assert.equal(list[1].pid, 1);
  assert.equal(list[1].isSystem, true);

  assert.equal(list[2].pid, 5678);
  assert.equal(list[2].isSuspended, true);
});

test('suspendProcess/resumeProcess/killProcess operate on target pid', async () => {
  const psStdout = ` %CPU   RSS STAT   PID USER COMM
  0.0  51200 S   5678 yoni /usr/local/bin/node
`;
  const runner = {
    execFile: async () => ({ stdout: psStdout, stderr: '', exitCode: 0 })
  };
  const signals = [];
  const service = createPortService({
    runner,
    selfPid: 9999,
    killFn: (pid, signal) => signals.push([pid, signal])
  });

  // Suspend (dryRun by default)
  const suspendDryRes = await service.suspendProcess({ pid: 5678 });
  assert.equal(suspendDryRes.dryRun, true);
  assert.equal(suspendDryRes.wouldSignal, 'SIGSTOP');

  // Suspend (confirm)
  const suspendRes = await service.suspendProcess({ pid: 5678, confirm: true });
  assert.deepEqual(suspendRes, { ok: true, pid: 5678, processName: 'node' });
  assert.deepEqual(signals, [[5678, 'SIGSTOP']]);

  // Resume
  const resumeRes = await service.resumeProcess({ pid: 5678 });
  assert.deepEqual(resumeRes, { ok: true, pid: 5678, processName: 'node' });
  assert.deepEqual(signals, [[5678, 'SIGSTOP'], [5678, 'SIGCONT']]);

  // Kill (dryRun by default)
  const killDryRes = await service.killProcess({ pid: 5678 });
  assert.equal(killDryRes.dryRun, true);
  assert.equal(killDryRes.wouldSignal, 'SIGTERM');

  // Kill (confirm)
  const killConfirmRes = await service.killProcess({ pid: 5678, confirm: true });
  assert.equal(killConfirmRes.dryRun, false);
  assert.equal(killConfirmRes.signalSent, 'SIGTERM');
  assert.deepEqual(signals, [[5678, 'SIGSTOP'], [5678, 'SIGCONT'], [5678, 'SIGTERM']]);
});



