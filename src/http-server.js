const express = require('express');
const path = require('node:path');
const { createPortService, PortManagerError } = require('./port-service');

const SERVER_TIMEOUT_MS = 30_000;
const HEADERS_TIMEOUT_MS = 35_000;

function errorToBody(error) {
  if (error instanceof PortManagerError) {
    return {
      error: {
        code: error.code,
        message: error.message,
        details: error.details || {},
      },
    };
  }

  return {
    error: {
      code: 'INTERNAL_ERROR',
      message: 'Unexpected server error',
      details: {},
    },
  };
}

function sendError(res, error) {
  if (!(error instanceof PortManagerError)) {
    console.error('Unexpected error:', error);
  }
  const status = error instanceof PortManagerError ? error.status : 500;
  res.status(status).json(errorToBody(error));
}

function createApp({ service = createPortService(), staticDir = path.join(__dirname, '..', 'public'), safetyLayer = null, config = null } = {}) {
  const app = express();

  // ─── Security Headers ───────────────────────────────────────────
  app.use((_req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Cache-Control', 'no-store');
    next();
  });

  app.use(express.json({ limit: '16kb' }));
  app.use(express.static(staticDir, { maxAge: 0 }));

  // ─── Server Timeouts ────────────────────────────────────────────
  app.use((_req, res, next) => {
    res.setTimeout(SERVER_TIMEOUT_MS, () => {
      res.status(503).json({ error: { code: 'TIMEOUT', message: 'Request timed out', details: { timeoutMs: SERVER_TIMEOUT_MS } } });
    });
    next();
  });

  // ─── API Routes ─────────────────────────────────────────────────

  app.get('/api/ports', async (_req, res) => {
    try {
      const ports = await service.listPorts();
      res.json({ ports });
    } catch (error) {
      sendError(res, error);
    }
  });

  app.get('/api/ports/:port', async (req, res) => {
    try {
      const port = Number(req.params.port);
      if (!Number.isInteger(port) || port < 1 || port > 65535) {
        return res.status(400).json({ error: { code: 'INVALID_PORT', message: 'Port must be an integer between 1 and 65535', details: { port: req.params.port } } });
      }
      const portInfo = await service.findProcessByPort({ port });
      res.json({ port: portInfo });
    } catch (error) {
      sendError(res, error);
    }
  });

  app.post('/api/ports/kill', async (req, res) => {
    try {
      const body = req.body || {};
      const port = Number(body.port);
      if (!Number.isInteger(port) || port < 1 || port > 65535) {
        return res.status(400).json({ error: { code: 'INVALID_PORT', message: 'Port must be an integer between 1 and 65535', details: { port: body.port } } });
      }
      const pid = Number(body.pid);
      if (!Number.isInteger(pid) || pid < 1) {
        return res.status(400).json({ error: { code: 'INVALID_PID', message: 'PID must be a positive integer', details: { pid: body.pid } } });
      }
      const result = await service.killProcessOnPort(req.body || {});
      res.json(result);
    } catch (error) {
      sendError(res, error);
    }
  });

  app.post('/api/ports/restart', async (req, res) => {
    try {
      await service.restartProcessOnPort(req.body || {});
      res.status(501).json({ error: { code: 'RESTART_NOT_IMPLEMENTED', message: 'Restart is disabled', details: {} } });
    } catch (error) {
      sendError(res, error);
    }
  });

  app.get('/api/system/usage', async (_req, res) => {
    try {
      const usage = await service.getSystemUsage();
      res.json(usage);
    } catch (error) {
      sendError(res, error);
    }
  });

  app.get('/api/system/processes', async (_req, res) => {
    try {
      const processes = await service.getSystemProcesses();
      res.json({ processes });
    } catch (error) {
      sendError(res, error);
    }
  });

  app.post('/api/system/suspend', async (req, res) => {
    try {
      const { pid } = req.body || {};
      const result = await service.suspendProcess({ pid });
      res.json(result);
    } catch (error) {
      sendError(res, error);
    }
  });

  app.post('/api/system/resume', async (req, res) => {
    try {
      const { pid } = req.body || {};
      const result = await service.resumeProcess({ pid });
      res.json(result);
    } catch (error) {
      sendError(res, error);
    }
  });

  app.post('/api/system/kill', async (req, res) => {
    try {
      const { pid, confirm } = req.body || {};
      const result = await service.killProcess({ pid, confirm });
      res.json(result);
    } catch (error) {
      sendError(res, error);
    }
  });

  // ─── Safety API ──────────────────────────────────────────────

  /** GET /api/safety — current safety status snapshot */
  app.get('/api/safety', (_req, res) => {
    if (!safetyLayer) {
      return res.status(501).json({ error: { code: 'SAFETY_UNAVAILABLE', message: 'Safety layer not configured', details: {} } });
    }
    res.json({ safety: safetyLayer.getStatus() });
  });

  /** POST /api/safety/mode — switch permission mode */
  app.post('/api/safety/mode', (req, res) => {
    if (!safetyLayer || !config) {
      return res.status(501).json({ error: { code: 'SAFETY_UNAVAILABLE', message: 'Safety layer not configured', details: {} } });
    }
    try {
      const { mode } = req.body || {};
      if (!['read-only', 'allowlist', 'blocklist'].includes(mode)) {
        return res.status(400).json({ error: { code: 'INVALID_MODE', message: 'Mode must be one of: read-only, allowlist, blocklist', details: { mode } } });
      }
      config.setMode(mode);
      safetyLayer.refreshRateLimiters();
      res.json({ ok: true, mode });
    } catch (error) {
      sendError(res, error);
    }
  });

  /** POST /api/safety/allowlist — manage allowlist */
  app.post('/api/safety/allowlist', (req, res) => {
    if (!safetyLayer || !config) {
      return res.status(501).json({ error: { code: 'SAFETY_UNAVAILABLE', message: 'Safety layer not configured', details: {} } });
    }
    try {
      const { action, port } = req.body || {};
      const portNum = Number(port);
      if (!Number.isInteger(portNum) || portNum < 1 || portNum > 65535) {
        return res.status(400).json({ error: { code: 'INVALID_PORT', message: 'Valid port number (1–65535) required', details: { port } } });
      }
      if (action === 'add') {
        config.addToAllowlist(portNum);
      } else if (action === 'remove') {
        config.removeFromAllowlist(portNum);
      } else {
        return res.status(400).json({ error: { code: 'INVALID_ACTION', message: 'Action must be "add" or "remove"', details: { action } } });
      }
      res.json({ ok: true, action, port: portNum, allowlist: [...config.allowlist].sort((a, b) => a - b) });
    } catch (error) {
      sendError(res, error);
    }
  });

  /** POST /api/safety/blocklist — manage blocklist */
  app.post('/api/safety/blocklist', (req, res) => {
    if (!safetyLayer || !config) {
      return res.status(501).json({ error: { code: 'SAFETY_UNAVAILABLE', message: 'Safety layer not configured', details: {} } });
    }
    try {
      const { action, port } = req.body || {};
      const portNum = Number(port);
      if (!Number.isInteger(portNum) || portNum < 1 || portNum > 65535) {
        return res.status(400).json({ error: { code: 'INVALID_PORT', message: 'Valid port number (1–65535) required', details: { port } } });
      }
      if (action === 'add') {
        config.addToBlocklist(portNum);
      } else if (action === 'remove') {
        config.removeFromBlocklist(portNum);
      } else {
        return res.status(400).json({ error: { code: 'INVALID_ACTION', message: 'Action must be "add" or "remove"', details: { action } } });
      }
      res.json({ ok: true, action, port: portNum, blocklist: [...config.blocklist].sort((a, b) => a - b) });
    } catch (error) {
      sendError(res, error);
    }
  });

  app.get('*', (_req, res) => {
    res.sendFile(path.join(staticDir, 'index.html'));
  });

  return app;
}

module.exports = {
  createApp,
  errorToBody,
  sendError,
  SERVER_TIMEOUT_MS,
  HEADERS_TIMEOUT_MS,
};
