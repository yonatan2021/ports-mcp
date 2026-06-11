const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const indexHtml = fs.readFileSync(path.join(root, 'public', 'index.html'), 'utf8');
const appJs = fs.readFileSync(path.join(root, 'public', 'app.js'), 'utf8');
const styleCss = fs.readFileSync(path.join(root, 'public', 'style.css'), 'utf8');

test('UI is self-contained and does not load remote fonts or telemetry assets', () => {
  assert.doesNotMatch(indexHtml, /fonts\.googleapis\.com|fonts\.gstatic\.com|https?:\/\//i);
  assert.match(indexHtml, /Content-Security-Policy/);
  assert.match(indexHtml, /default-src 'self'/);
  assert.match(styleCss, /system-ui/);
});

test('kill confirmation requires explicit PID entry before enabling destructive action', () => {
  assert.match(indexHtml, /id="confirm-pid-input"/);
  assert.match(indexHtml, /id="confirm-understand-checkbox"/);
  assert.match(appJs, /validateDestructiveConfirmation/);
  assert.match(appJs, /elements\.modalConfirmBtn\.disabled = !isValid/);
  assert.match(appJs, /String\(portObj\.pid\)/);
  assert.match(appJs, /const activeAction = portObj && typeof portObj\.pid !== 'undefined'/);
  assert.match(appJs, /activeAction === 'kill' && typedPidMatches && checkboxChecked/);
});

test('self and system ports render with disabled destructive controls and explanations', () => {
  assert.match(appJs, /const isSystemPort = Number\.isFinite\(portNumber\) && portNumber <= 1024/);
  assert.match(appJs, /const killDisabled = isSelf \|\| isSystemPort/);
  assert.match(appJs, /Self-protection: this is the Port Manager UI server/);
  assert.match(appJs, /System-port protection: ports 1024 and below/);
  assert.match(appJs, /Restart disabled: arbitrary command restart is not available/);
  assert.match(appJs, /const portText = escapeHtml\(String\(portObj\.port \?\? ''\)\)/);
  assert.match(appJs, /const pidText = escapeHtml\(String\(portObj\.pid \?\? ''\)\)/);
});
