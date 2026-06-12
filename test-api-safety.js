const { SafetyConfig } = require('./src/config');
const { SafetyLayer } = require('./src/safety');
const { createPortService } = require('./src/port-service');
const { createApp } = require('./src/http-server');
const http = require('http');

const config = new SafetyConfig();
const safetyLayer = new SafetyLayer({ config });
const service = createPortService({ safetyLayer });
const app = createApp({ service, safetyLayer, config });

const PORT = 19999;
const server = app.listen(PORT, '127.0.0.1', async () => {
  const fetchJSON = (path, opts) => new Promise((resolve, reject) => {
    const options = {
      hostname: '127.0.0.1',
      port: PORT,
      path,
      method: (opts && opts.method) || 'GET',
      headers: { 'Content-Type': 'application/json', ...(opts && opts.headers) },
    };
    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => data += chunk);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(data || '{}') }); }
        catch (e) { resolve({ status: res.statusCode, body: {} }); }
      });
    });
    req.on('error', reject);
    if (opts && opts.body) req.write(opts.body);
    req.end();
  });

  try {
    // 1. GET /api/safety
    const s = await fetchJSON('/api/safety');
    console.log('GET /api/safety:', JSON.stringify({ status: s.status, mode: s.body.safety?.mode }));

    // 2. POST /api/safety/mode -> allowlist
    const m1 = await fetchJSON('/api/safety/mode', { method: 'POST', body: JSON.stringify({ mode: 'allowlist' }) });
    console.log('POST mode(allowlist):', JSON.stringify(m1.body));

    // 3. POST allowlist add
    const a1 = await fetchJSON('/api/safety/allowlist', { method: 'POST', body: JSON.stringify({ action: 'add', port: 3000 }) });
    console.log('POST allowlist(add 3000): allowlist=' + JSON.stringify(a1.body.allowlist));

    // 4. POST blocklist add
    const b1 = await fetchJSON('/api/safety/blocklist', { method: 'POST', body: JSON.stringify({ action: 'add', port: 8080 }) });
    console.log('POST blocklist(add 8080): blocklist=' + JSON.stringify(b1.body.blocklist));

    // 5. POST allowlist remove
    const a2 = await fetchJSON('/api/safety/allowlist', { method: 'POST', body: JSON.stringify({ action: 'remove', port: 3000 }) });
    console.log('POST allowlist(remove 3000): allowlist=' + JSON.stringify(a2.body.allowlist));

    // 6. POST mode back to read-only
    const m2 = await fetchJSON('/api/safety/mode', { method: 'POST', body: JSON.stringify({ mode: 'read-only' }) });
    console.log('POST mode(read-only):', JSON.stringify(m2.body));

    // 7. Error: invalid mode
    const e1 = await fetchJSON('/api/safety/mode', { method: 'POST', body: JSON.stringify({ mode: 'invalid' }) });
    console.log('POST mode(invalid): status=' + e1.status + ' code=' + (e1.body.error?.code));

    // 8. Error: invalid port
    const e2 = await fetchJSON('/api/safety/allowlist', { method: 'POST', body: JSON.stringify({ action: 'add', port: 99999 }) });
    console.log('POST allowlist(port=99999): status=' + e2.status + ' code=' + (e2.body.error?.code));

    console.log('ALL ENDPOINTS OK');
  } catch (err) {
    console.error('FAIL:', err.message);
    process.exitCode = 1;
  } finally {
    server.close();
  }
});
