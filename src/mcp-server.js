#!/usr/bin/env node

const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const { z } = require('zod');
const { createPortService, PortManagerError } = require('./port-service');
const { SafetyConfig } = require('./config');
const { SafetyLayer } = require('./safety');

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

function createMcpServer({ service, config, safetyLayer } = {}) {
  // === Bootstrap safety config + safety layer if not injected ===
  if (!config) {
    config = new SafetyConfig();
  }
  if (!safetyLayer) {
    safetyLayer = new SafetyLayer({ config });
  }
  if (!service) {
    service = createPortService({ safetyLayer });
  }

  const server = new McpServer({ name: 'ports-mcp', version: '1.0.0' });

  // ======================================================================
  // TOOL: list_ports
  // ======================================================================
  server.registerTool(
    'list_ports',
    {
      title: 'List listening TCP ports',
      description: 'Returns active listening TCP ports with pid, processName, user, protocol/type, address, and commandLine. Safe — always allowed regardless of permission mode.',
      inputSchema: {},
    },
    async () => {
      try {
        return jsonText({ ports: await service.listPorts() });
      } catch (error) {
        return errorResult(error);
      }
    }
  );

  // ======================================================================
  // TOOL: find_process_by_port
  // ======================================================================
  server.registerTool(
    'find_process_by_port',
    {
      title: 'Find process by port',
      description: 'Returns details for the listening process on a specific TCP port. Safe — always allowed.',
      inputSchema: {
        port: z.number().int().min(1).max(65535),
      },
    },
    async ({ port }) => {
      try {
        return jsonText({ port: await service.findProcessByPort({ port }) });
      } catch (error) {
        return errorResult(error);
      }
    }
  );

  // ======================================================================
  // TOOL: kill_process_on_port
  // ======================================================================
  server.registerTool(
    'kill_process_on_port',
    {
      title: 'Kill process on port',
      description: [
        'Guarded destructive action. Subject to the server\'s safety permission layer:',
        '- If mode=read-only (default): blocked entirely.',
        '- If mode=allowlist: only ports in the allowlist can be killed.',
        '- If mode=blocklist: ports in the blocklist are protected.',
        '',
        'Additional protections:',
        '- Owner verification: can only kill processes owned by the same user.',
        '- System process protection: critical OS processes are always blocked.',
        '- System ports (<1024): blocked unless added to allowlist.',
        '- Rate limiting: max 5 kills/minute with 3s cooldown (configurable).',
        '- Refuses to kill the MCP server itself.',
        '',
        'Dry-run by default (confirm=false). Set confirm=true to execute.',
        'Set force=true to escalate from SIGTERM to SIGKILL if still alive.',
      ].join('\n'),
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
    async (args) => {
      try {
        return jsonText(await service.killProcessOnPort(args));
      } catch (error) {
        return errorResult(error);
      }
    }
  );

  // ======================================================================
  // TOOL: restart_process_on_port (intentionally disabled)
  // ======================================================================
  server.registerTool(
    'restart_process_on_port',
    {
      title: 'Restart process on port (disabled)',
      description: 'Intentionally disabled. Arbitrary shell command restart is unsafe without an explicit command allowlist.',
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
    async (args) => {
      try {
        return jsonText(await service.restartProcessOnPort(args));
      } catch (error) {
        return errorResult(error);
      }
    }
  );

  // ======================================================================
  // SAFETY TOOLS — Configuration Management
  // ======================================================================

  // --------------------------------------------------------------------
  // TOOL: get_safety_config
  // --------------------------------------------------------------------
  server.registerTool(
    'get_safety_config',
    {
      title: 'Get safety configuration',
      description: [
        'Returns the current safety layer configuration including:',
        '- mode (read-only | allowlist | blocklist)',
        '- allowlist and blocklist contents',
        '- rate limiter and cooldown settings',
        '- verification status',
      ].join('\n'),
      inputSchema: {},
    },
    async () => {
      try {
        return jsonText(await safetyLayer.getStatus());
      } catch (error) {
        return errorResult(error);
      }
    }
  );

  // --------------------------------------------------------------------
  // TOOL: set_mode
  // --------------------------------------------------------------------
  server.registerTool(
    'set_mode',
    {
      title: 'Set permission mode',
      description: 'Change the safety permission mode. "read-only" = no destructive ops. "allowlist" = only ports in the allowlist. "blocklist" = ports in the blocklist are protected.',
      inputSchema: {
        mode: z.enum(['read-only', 'allowlist', 'blocklist']),
      },
    },
    async ({ mode }) => {
      try {
        config.setMode(mode);
        return jsonText({ ok: true, mode: config.mode });
      } catch (error) {
        return jsonText({ ok: false, error: error.message });
      }
    }
  );

  // --------------------------------------------------------------------
  // TOOL: set_allowlist
  // --------------------------------------------------------------------
  server.registerTool(
    'set_allowlist',
    {
      title: 'Set allowlist',
      description: 'Replace the entire allowlist with a new set of port numbers. In allowlist mode, only these ports can be killed.',
      inputSchema: {
        ports: z.array(z.number().int().min(1).max(65535)),
      },
    },
    async ({ ports }) => {
      try {
        config.setAllowlist(ports);
        return jsonText({ ok: true, allowlist: [...config.allowlist].sort((a, b) => a - b) });
      } catch (error) {
        return jsonText({ ok: false, error: error.message });
      }
    }
  );

  // --------------------------------------------------------------------
  // TOOL: add_to_allowlist
  // --------------------------------------------------------------------
  server.registerTool(
    'add_to_allowlist',
    {
      title: 'Add port to allowlist',
      description: 'Add a single port to the allowlist. In allowlist mode, this permits destructive operations on this port.',
      inputSchema: {
        port: z.number().int().min(1).max(65535),
      },
    },
    async ({ port }) => {
      try {
        config.addToAllowlist(port);
        return jsonText({ ok: true, port, allowlist: [...config.allowlist].sort((a, b) => a - b) });
      } catch (error) {
        return jsonText({ ok: false, error: error.message });
      }
    }
  );

  // --------------------------------------------------------------------
  // TOOL: remove_from_allowlist
  // --------------------------------------------------------------------
  server.registerTool(
    'remove_from_allowlist',
    {
      title: 'Remove port from allowlist',
      description: 'Remove a single port from the allowlist. If in allowlist mode, this port can no longer be killed.',
      inputSchema: {
        port: z.number().int().min(1).max(65535),
      },
    },
    async ({ port }) => {
      try {
        config.removeFromAllowlist(port);
        return jsonText({ ok: true, port, allowlist: [...config.allowlist].sort((a, b) => a - b) });
      } catch (error) {
        return jsonText({ ok: false, error: error.message });
      }
    }
  );

  // --------------------------------------------------------------------
  // TOOL: set_blocklist
  // --------------------------------------------------------------------
  server.registerTool(
    'set_blocklist',
    {
      title: 'Set blocklist',
      description: 'Replace the entire blocklist with a new set of port numbers. In blocklist mode, these ports are protected from destructive operations.',
      inputSchema: {
        ports: z.array(z.number().int().min(1).max(65535)),
      },
    },
    async ({ ports }) => {
      try {
        config.setBlocklist(ports);
        return jsonText({ ok: true, blocklist: [...config.blocklist].sort((a, b) => a - b) });
      } catch (error) {
        return jsonText({ ok: false, error: error.message });
      }
    }
  );

  // --------------------------------------------------------------------
  // TOOL: add_to_blocklist
  // --------------------------------------------------------------------
  server.registerTool(
    'add_to_blocklist',
    {
      title: 'Add port to blocklist',
      description: 'Add a single port to the blocklist. In blocklist mode, this protects the port from destructive operations.',
      inputSchema: {
        port: z.number().int().min(1).max(65535),
      },
    },
    async ({ port }) => {
      try {
        config.addToBlocklist(port);
        return jsonText({ ok: true, port, blocklist: [...config.blocklist].sort((a, b) => a - b) });
      } catch (error) {
        return jsonText({ ok: false, error: error.message });
      }
    }
  );

  // --------------------------------------------------------------------
  // TOOL: remove_from_blocklist
  // --------------------------------------------------------------------
  server.registerTool(
    'remove_from_blocklist',
    {
      title: 'Remove port from blocklist',
      description: 'Remove a single port from the blocklist. If in blocklist mode, this port can now be killed (subject to other safety checks).',
      inputSchema: {
        port: z.number().int().min(1).max(65535),
      },
    },
    async ({ port }) => {
      try {
        config.removeFromBlocklist(port);
        return jsonText({ ok: true, port, blocklist: [...config.blocklist].sort((a, b) => a - b) });
      } catch (error) {
        return jsonText({ ok: false, error: error.message });
      }
    }
  );

  // --------------------------------------------------------------------
  // TOOL: update_rate_limits
  // --------------------------------------------------------------------
  server.registerTool(
    'update_rate_limits',
    {
      title: 'Update rate limit settings',
      description: 'Change rate limiting and cooldown parameters. Reset rate limiter counters.',
      inputSchema: {
        maxOpsPerMinute: z.number().int().min(1).max(100).optional(),
        cooldownMs: z.number().int().min(0).max(60_000).optional(),
      },
    },
    async ({ maxOpsPerMinute, cooldownMs } = {}) => {
      try {
        if (maxOpsPerMinute !== undefined) {
          config.setMaxOpsPerMinute(maxOpsPerMinute);
        }
        if (cooldownMs !== undefined) {
          config.setCooldownMs(cooldownMs);
        }
        safetyLayer.refreshRateLimiters();
        return jsonText({
          ok: true,
          maxOpsPerMinute: config.maxOpsPerMinute,
          cooldownMs: config.cooldownMs,
        });
      } catch (error) {
        return jsonText({ ok: false, error: error.message });
      }
    }
  );

  return server;
}

async function main() {
  const config = new SafetyConfig();
  const safetyLayer = new SafetyLayer({ config });
  const service = createPortService({ safetyLayer });
  const server = createMcpServer({ service, config, safetyLayer });
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
  SafetyConfig,
  SafetyLayer,
};
