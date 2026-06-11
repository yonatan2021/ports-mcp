#!/usr/bin/env node

const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const { z } = require('zod');
const { createPortService, PortManagerError } = require('./port-service');

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

function createMcpServer({ service = createPortService() } = {}) {
  const server = new McpServer({ name: 'ports-mcp', version: '1.0.0' });

  server.registerTool(
    'list_ports',
    {
      title: 'List listening TCP ports',
      description: 'Returns active listening TCP ports with pid, processName, user, protocol/type, address, and commandLine.',
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

  server.registerTool(
    'find_process_by_port',
    {
      title: 'Find process by port',
      description: 'Returns details for the listening process on a specific TCP port.',
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

  server.registerTool(
    'kill_process_on_port',
    {
      title: 'Kill process on port',
      description: 'Guarded destructive action. Validates pid/port match, refuses self, refuses system ports unless allowSystemPort=true, dry-runs unless confirm=true, sends SIGTERM first with optional SIGKILL fallback.',
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
    async (args) => {
      try {
        return jsonText(await service.restartProcessOnPort(args));
      } catch (error) {
        return errorResult(error);
      }
    }
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
