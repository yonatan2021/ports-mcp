#!/usr/bin/env node

const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const { z } = require('zod');
const { createPortService, PortManagerError, MAX_PORTS_RETURNED } = require('./port-service');
const { createAgentTools } = require('./mcp-tools');

const TOOL_TIMEOUT_MS = 15_000;

function withTimeout(fn, label) {
  return async (...args) => {
    const result = await Promise.race([
      fn(...args),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error(`Tool "${label}" timed out after ${TOOL_TIMEOUT_MS}ms`)), TOOL_TIMEOUT_MS)
      ),
    ]);
    return result;
  };
}

function jsonText(payload) {
  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify(payload, null, 2),
      },
    ],
  };
}

function errorResult(error) {
  const payload = error instanceof PortManagerError
    ? { error: { code: error.code, message: error.message, details: error.details || {} } }
    : { error: { code: 'INTERNAL_ERROR', message: error.message || 'Unexpected error', details: {} } };

  return {
    isError: true,
    ...jsonText(payload),
  };
}

const SAFETY_WARNING_LIST_PORTS = 'Returns active listening TCP ports with process and user information. IMPORTANT: Command-line arguments may contain tokens, file paths, or credentials. Handle output as sensitive data.';
const SAFETY_WARNING_KILL = 'DESTRUCTIVE ACTION. Terminates a process by sending SIGTERM (and optionally SIGKILL). Requires explicit confirm=true. Validates pid/port match before acting. Refuses to terminate: self (Port Manager), system ports (<1024), and blocklisted system processes. Rate-limited to 5 kills/minute with 3s cooldown.';

function createMcpServer({ service = createPortService(), safetyLayer = null } = {}) {
  const server = new McpServer({ name: 'ports-mcp', version: '1.0.0' });

  // Agent-optimized tools with structured JSON and safety guards
  const childProcess = require('node:child_process');
  function defaultExecFile(file, args, options = {}) {
    return new Promise((resolve, reject) => {
      childProcess.execFile(file, args, { timeout: 10_000, maxBuffer: 2 * 1024 * 1024, ...options }, (error, stdout, stderr) => {
        const exitCode = error && typeof error.code === 'number' ? error.code : 0;
        if (error && !options.allowNonZero) {
          error.stdout = stdout;
          error.stderr = stderr;
          reject(error);
          return;
        }
        resolve({ stdout, stderr, exitCode });
      });
    });
  }
  const agentTools = createAgentTools({ service, safetyLayer, runner: { execFile: defaultExecFile } });

  server.registerTool(
    'list_ports',
    {
      title: 'List listening TCP ports',
      description: SAFETY_WARNING_LIST_PORTS + ' Response capped at ' + MAX_PORTS_RETURNED + ' ports.',
      inputSchema: {},
    },
    withTimeout(async () => {
      try {
        const ports = await service.listPorts();
        const capped = ports.slice(0, MAX_PORTS_RETURNED);
        return jsonText({ ports: capped, _meta: { count: capped.length, maxReturned: MAX_PORTS_RETURNED } });
      } catch (error) {
        return errorResult(error);
      }
    }, 'list_ports')
  );

  server.registerTool(
    'find_process_by_port',
    {
      title: 'Find process by port',
      description: 'Returns details for the listening process on a specific TCP port.',
      inputSchema: {
        port: z.number().int().min(1).max(65535),
      },
    },
    withTimeout(async ({ port }) => {
      try {
        return jsonText({ port: await service.findProcessByPort({ port }) });
      } catch (error) {
        return errorResult(error);
      }
    }, 'find_process_by_port')
  );

  server.registerTool(
    'kill_process_on_port',
    {
      title: 'Kill process on port',
      description: SAFETY_WARNING_KILL + ' Params: port, pid, confirm (default false), allowSystemPort (default false), force (default false).',
      inputSchema: {
        port: z.number().int().min(1).max(65535),
        pid: z.number().int().min(1),
        confirm: z.boolean().optional().default(false),
        allowSystemPort: z.boolean().optional().default(false),
        force: z.boolean().optional().default(false),
      },
      annotations: {
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    withTimeout(async (args) => {
      try {
        return jsonText(await service.killProcessOnPort(args));
      } catch (error) {
        return errorResult(error);
      }
    }, 'kill_process_on_port')
  );

  server.registerTool(
    'restart_process_on_port',
    {
      title: 'Restart process on port (disabled)',
      description: 'Intentionally disabled. Arbitrary shell command restart is unsafe without an explicit allowlist.',
      inputSchema: {
        port: z.number().int().min(1).max(65535),
        pid: z.number().int().min(1),
        commandLine: z.string().optional(),
      },
      annotations: {
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    withTimeout(async (args) => {
      try {
        return jsonText(await service.restartProcessOnPort(args));
      } catch (error) {
        return errorResult(error);
      }
    }, 'restart_process_on_port')
  );

  // ======================================================================
  // AGENT-OPTIMIZED TOOLS — structured JSON, safe by default
  // ======================================================================

  server.registerTool(
    'verify_process_owner',
    {
      title: 'Verify process ownership',
      description: [
        'Returns the owner (username) of a process listening on a given port + PID.',
        '',
        'WARNING: Read-only informational tool. No destructive action is performed.',
        '',
        'Uses both lsof and ps to verify the owner. Double-check confirms owner',
        'even when one data source is unreliable.',
      ].join('\n'),
      inputSchema: {
        port: z.number().int().min(1).max(65535).describe('WARNING: Must match a currently listening port.'),
        pid: z.number().int().min(1).describe('WARNING: Must match the actual PID holding the given port.'),
      },
      annotations: {
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    withTimeout(async ({ port, pid }) => {
      const result = await agentTools.verifyProcessOwner({ port, pid });
      if (result.error) {
        return { isError: true, ...jsonText(result) };
      }
      return jsonText(result);
    }, 'verify_process_owner')
  );

  server.registerTool(
    'get_process_details',
    {
      title: 'Get detailed process information',
      description: [
        'Full process information for a given port and optional PID:',
        '- pid, port, processName, user, commandLine, uptime, ppid, protocol, address',
        '',
        'WARNING: Read-only informational tool. No destructive action is performed.',
        '',
        'Enriches standard lsof output with ps data (uptime, ppid, full command line).',
        'Use this before safe_kill_process to confirm you have the right target.',
      ].join('\n'),
      inputSchema: {
        port: z.number().int().min(1).max(65535),
        pid: z.number().int().min(1).optional().describe('Optional: disambiguates when multiple processes listen on the same port.'),
      },
      annotations: {
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    withTimeout(async ({ port, pid }) => {
      const result = await agentTools.getProcessDetails({ port, pid });
      if (result.error) {
        return { isError: true, ...jsonText(result) };
      }
      return jsonText(result);
    }, 'get_process_details')
  );

  server.registerTool(
    'safe_kill_process',
    {
      title: 'Safely kill a process (guarded)',
      description: [
        'WARNING: Destructive action. Terminates a process by sending SIGTERM.',
        '',
        'Safety guards (ALL must pass before execution):',
        '  1. Permission mode — read-only blocks all kills',
        '  2. Allowlist/Blocklist — port must be allowed (or not blocked) per current mode',
        '  3. System port protection — ports < 1024 blocked unless in allowlist',
        '  4. Process name blocklist — system processes (launchd, kernel_task, etc.) always blocked',
        '  5. Owner verification — can only kill processes owned by the same user running the MCP',
        '  6. Rate limiting — max N kills per minute with cooldown between operations',
        '',
        'Dry-run by default (confirm=false). Use confirm=true to execute.',
        'Use force=true to escalate to SIGKILL if the process survives SIGTERM.',
      ].join('\n'),
      inputSchema: {
        port: z.number().int().min(1).max(65535).describe('WARNING: Must match a currently listening port. Safety checks include system port protection and mode/allowlist.'),
        pid: z.number().int().min(1).describe('WARNING: Must match the actual PID holding the port. Verified against both lsof and the port+pid match check.'),
        confirm: z.boolean().optional().default(false).describe('Set true to actually send SIGTERM. Without it, this is a dry run with no side effects.'),
        force: z.boolean().optional().default(false).describe('Set true to follow up with SIGKILL if the process does not terminate after SIGTERM.'),
      },
      annotations: {
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    withTimeout(async ({ port, pid, confirm, force }) => {
      const result = await agentTools.safeKillProcess({ port, pid, confirm, force });
      if (result.error) {
        return { isError: true, ...jsonText(result) };
      }
      return jsonText(result);
    }, 'safe_kill_process')
  );

  server.registerTool(
    'safe_restart_process',
    {
      title: 'Restart process (disabled)',
      description: [
        'WARNING: Intentionally disabled. Restarting a process requires executing an arbitrary',
        'shell command, which is unsafe without an explicit command allowlist.',
        '',
        'This tool will always return an error until a command allowlist feature is implemented.',
      ].join('\n'),
      inputSchema: {
        port: z.number().int().min(1).max(65535),
        pid: z.number().int().min(1),
        commandLine: z.string().optional().describe('Command to restart with (ignored — feature not implemented).'),
      },
      annotations: {
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    withTimeout(async ({ port, pid, commandLine }) => {
      const result = await agentTools.safeRestartProcess({ port, pid, commandLine });
      return { isError: true, ...jsonText(result) };
    }, 'safe_restart_process')
  );

  server.registerTool(
    'get_safety_status',
    {
      title: 'Get safety status',
      description: [
        'Returns the current safety configuration and rate-limiter state:',
        '- mode (read-only / allowlist / blocklist)',
        '- verifyOwner setting',
        '- current user, self PID, self port',
        '- allowlist contents, blocklist count, process blocklist count',
        '- rate limit: max per minute and active operations in current window',
        '- cooldown: configured interval and time since last operation',
        '',
        'WARNING: Read-only informational tool. No destructive action is performed.',
        '',
        'Use this before safe_kill_process to understand what is protected and whether',
        'you need to adjust the mode, allowlist, or rate limits first.',
      ].join('\n'),
      inputSchema: {},
      annotations: {
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    withTimeout(async () => {
      const result = await agentTools.getSafetyStatus();
      if (result.error) {
        return { isError: true, ...jsonText(result) };
      }
      return jsonText(result);
    }, 'get_safety_status')
  );

  server.registerTool(
    'get_system_usage',
    {
      title: 'Get system CPU and memory usage',
      description: 'Returns real-time usage percentages for system-wide CPU and memory.',
      inputSchema: {},
    },
    withTimeout(async () => {
      const result = await agentTools.getSystemUsage();
      if (result.error) {
        return { isError: true, ...jsonText(result) };
      }
      return jsonText(result);
    }, 'get_system_usage')
  );

  server.registerTool(
    'list_system_processes',
    {
      title: 'List resource-heavy system processes',
      description: 'Returns the top 50 resource-heavy active processes running on macOS, indicating which are system processes.',
      inputSchema: {},
    },
    withTimeout(async () => {
      const result = await agentTools.listSystemProcesses();
      if (result.error) {
        return { isError: true, ...jsonText(result) };
      }
      return jsonText(result);
    }, 'list_system_processes')
  );

  server.registerTool(
    'suspend_process',
    {
      title: 'Suspend/Pause a process',
      description: 'Suspends an active process using SIGSTOP. Requires PID. Critical system processes are protected.',
      inputSchema: {
        pid: z.number().int().min(1),
      },
    },
    withTimeout(async ({ pid }) => {
      const result = await agentTools.suspendProcess({ pid });
      if (result.error) {
        return { isError: true, ...jsonText(result) };
      }
      return jsonText(result);
    }, 'suspend_process')
  );

  server.registerTool(
    'resume_process',
    {
      title: 'Resume/Wake up a suspended process',
      description: 'Resumes a suspended process using SIGCONT. Requires PID.',
      inputSchema: {
        pid: z.number().int().min(1),
      },
    },
    withTimeout(async ({ pid }) => {
      const result = await agentTools.resumeProcess({ pid });
      if (result.error) {
        return { isError: true, ...jsonText(result) };
      }
      return jsonText(result);
    }, 'resume_process')
  );

  return server;
}

async function main() {
  const server = createMcpServer();
  await server.connect(new StdioServerTransport());
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}

module.exports = {
  createMcpServer,
};
