const http = require('node:http');

function validatePort(port) {
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new TypeError('port must be an integer between 0 and 65535');
  }
}

async function startLocalServer({ app, port = 0 } = {}) {
  if (!app) throw new TypeError('app is required');
  validatePort(port);

  const host = '127.0.0.1';
  const server = http.createServer(app);
  server.timeout = 30_000;
  server.headersTimeout = 35_000;

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.off('error', reject);
      resolve();
    });
  });

  const address = server.address();
  const actualPort = typeof address === 'object' && address ? address.port : port;

  return {
    server,
    host,
    port: actualPort,
    url: `http://${host}:${actualPort}`,
    close: () => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
  };
}

module.exports = { startLocalServer, validatePort };
