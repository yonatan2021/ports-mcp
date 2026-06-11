const { createApp } = require('./src/http-server');

const PORT = Number.parseInt(process.env.PORT || '9999', 10);
const HOST = process.env.HOST || '127.0.0.1';

if (!Number.isInteger(PORT) || PORT < 1 || PORT > 65535) {
  console.error('PORT must be an integer between 1 and 65535');
  process.exit(1);
}

const app = createApp();

app.listen(PORT, HOST, () => {
  console.log(`Port Manager running at http://${HOST}:${PORT}`);
});
