const http = require('node:http');
const { createApp, SERVER_TIMEOUT_MS, HEADERS_TIMEOUT_MS } = require('./src/http-server');
const { SafetyConfig } = require('./src/config');
const { SafetyLayer } = require('./src/safety');
const { createPortService } = require('./src/port-service');
const { createAppInfoProvider } = require('./src/app-info');
const packageJson = require('./package.json');

const PORT = Number.parseInt(process.env.PORT || '9999', 10);
const HOST = process.env.HOST || '127.0.0.1';

if (!Number.isInteger(PORT) || PORT < 1 || PORT > 65535) {
  console.error('PORT must be an integer between 1 and 65535');
  process.exit(1);
}

const config = new SafetyConfig();
const safetyLayer = new SafetyLayer({ config });
const service = createPortService({ safetyLayer });
const getAppInfo = createAppInfoProvider({ currentVersion: packageJson.version });
const app = createApp({ service, safetyLayer, config, getAppInfo });
const server = http.createServer(app);

server.timeout = SERVER_TIMEOUT_MS;
server.headersTimeout = HEADERS_TIMEOUT_MS;

server.listen(PORT, HOST, () => {
  console.log(`Port Manager running at http://${HOST}:${PORT}`);
  console.log(`Safety mode: ${config.mode}`);
});
