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
