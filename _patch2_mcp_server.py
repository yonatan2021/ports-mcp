import sys

# Read the file
with open('src/mcp-server.js', 'r') as f:
    content = f.read()

# Find the position of '  return server;'
target = '  return server;\n}'
insert_pos = content.find(target)
if insert_pos == -1:
    print('ERROR: Could not find return server marker')
    sys.exit(1)

# The agent tools code to insert
agent_tools_code = '''  // ======================================================================
  // AGENT-OPTIMIZED TOOLS — structured JSON, rich descriptions, safe
  // ======================================================================

  // Create a default execFile runner for process enrichment
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

  // --------------------------------------------------------------------
  // TOOL: verify_process_owner
  // --------------------------------------------------------------------
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
      ].join('\\n'),
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
    async ({ port, pid }) => {
      const result = await agentTools.verifyProcessOwner({ port, pid });
      if (result.error) {
        return { isError: true, ...jsonText(result) };
      }
      return jsonText(result);
    }
  );

  // --------------------------------------------------------------------
  // TOOL: get_process_details
  // --------------------------------------------------------------------
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
      ].join('\\n'),
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
    async ({ port, pid }) => {
      const result = await agentTools.getProcessDetails({ port, pid });
      if (result.error) {
        return { isError: true, ...jsonText(result) };
      }
      return jsonText(result);
    }
  );

  // --------------------------------------------------------------------
  // TOOL: safe_kill_process
  // --------------------------------------------------------------------
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
      ].join('\\n'),
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
    async ({ port, pid, confirm, force }) => {
      const result = await agentTools.safeKillProcess({ port, pid, confirm, force });
      if (result.error) {
        return { isError: true, ...jsonText(result) };
      }
      return jsonText(result);
    }
  );

  // --------------------------------------------------------------------
  // TOOL: safe_restart_process (intentionally disabled)
  // --------------------------------------------------------------------
  server.registerTool(
    'safe_restart_process',
    {
      title: 'Restart process (disabled)',
      description: [
        'WARNING: Intentionally disabled. Restarting a process requires executing an arbitrary',
        'shell command, which is unsafe without an explicit command allowlist.',
        '',
        'This tool will always return an error until a command allowlist feature is implemented.',
      ].join('\\n'),
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
    async ({ port, pid, commandLine }) => {
      const result = await agentTools.safeRestartProcess({ port, pid, commandLine });
      return { isError: true, ...jsonText(result) };
    }
  );

  // --------------------------------------------------------------------
  // TOOL: get_safety_status
  // --------------------------------------------------------------------
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
      ].join('\\n'),
      inputSchema: {},
      annotations: {
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async () => {
      const result = await agentTools.getSafetyStatus();
      if (result.error) {
        return { isError: true, ...jsonText(result) };
      }
      return jsonText(result);
    }
  );

'''

# Insert the agent tools code before 'return server;'
new_content = content[:insert_pos] + agent_tools_code + content[insert_pos:]

with open('src/mcp-server.js', 'w') as f:
    f.write(new_content)

print('OK - agent tools inserted')
