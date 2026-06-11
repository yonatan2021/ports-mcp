const express = require('express');
const path = require('node:path');
const { createPortService, PortManagerError } = require('./port-service');

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

function createApp({ service = createPortService(), staticDir = path.join(__dirname, '..', 'public') } = {}) {
  const app = express();

  app.use(express.json({ limit: '16kb' }));
  app.use(express.static(staticDir));

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
      const portInfo = await service.findProcessByPort({ port: req.params.port });
      res.json({ port: portInfo });
    } catch (error) {
      sendError(res, error);
    }
  });

  app.post('/api/ports/kill', async (req, res) => {
    try {
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

  app.get('*', (_req, res) => {
    res.sendFile(path.join(staticDir, 'index.html'));
  });

  return app;
}

module.exports = {
  createApp,
  errorToBody,
  sendError,
};
