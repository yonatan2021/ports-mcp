const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const indexHtml = fs.readFileSync(path.join(root, 'public', 'index.html'), 'utf8');
const appJs = fs.readFileSync(path.join(root, 'public', 'app.js'), 'utf8');
const styleCss = fs.readFileSync(path.join(root, 'public', 'style.css'), 'utf8');
const settingsJs = fs.readFileSync(path.join(root, 'public', 'settings.js'), 'utf8');

test('UI is self-contained and does not load remote fonts or telemetry assets', () => {
  assert.doesNotMatch(indexHtml, /fonts\.googleapis\.com|fonts\.gstatic\.com|https?:\/\//i);
  assert.match(indexHtml, /Content-Security-Policy/);
  assert.match(indexHtml, /default-src 'self'/);
  assert.match(styleCss, /system-ui/);
});

test('UI has RTL support with lang=he and dir=rtl', () => {
  assert.match(indexHtml, /lang="he"/);
  assert.match(indexHtml, /dir="rtl"/);
});

test('UI shows app version, update availability, and Bersaglio copyright', () => {
  assert.match(indexHtml, /id="current-version"/);
  assert.match(indexHtml, /id="update-status"/);
  assert.match(indexHtml, /id="update-button"/);
  assert.match(indexHtml, /Bersaglio/);
  assert.match(appJs, /fetch\('\/api\/app-info'/);
  assert.match(appJs, /window\.portManager\.applyUpdate\(\)/);
  assert.doesNotMatch(appJs, /\/api\/app-update|X-Update-Token|appUpdateToken/);
  assert.match(styleCss, /\.app-footer/);
  assert.match(styleCss, /\.update-status\.available/);
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
  assert.match(appJs, /const isSystemProcess = portObj\.isSystem === true/);
  assert.match(appJs, /const killDisabled = isAggregate \|\| isSelf \|\| isSystemProcess/);
  assert.match(appJs, /Self-protection: this is the Port Manager UI server/);
  assert.match(appJs, /System-process protection/);
  assert.match(appJs, /Restart disabled: arbitrary command restart is not available/);
  assert.match(appJs, /const portText = escapeHtml\(\(portObj\.ports \|\| \[portObj\.port\]\)\.join\(', '\)\)/);
  assert.match(appJs, /const pidText = escapeHtml\(\(portObj\.pids \|\| \[portObj\.pid\]\)\.join\(', '\)\)/);
});

test('settings panel is present in HTML with all sections', () => {
  assert.match(indexHtml, /id="settings-panel"/);
  assert.match(indexHtml, /id="settings-btn"/);
  assert.match(indexHtml, /id="settings-overlay"/);
  assert.match(indexHtml, /id="settings-close-btn"/);
  assert.match(indexHtml, /Safety Settings/);

  // Mode selector
  assert.match(indexHtml, /id="mode-readonly"/);
  assert.match(indexHtml, /id="mode-allowlist"/);
  assert.match(indexHtml, /id="mode-blocklist"/);
  assert.match(indexHtml, /name="safety-mode"/);

  // Allowlist
  assert.match(indexHtml, /id="allowlist-section"/);
  assert.match(indexHtml, /id="allowlist-input"/);
  assert.match(indexHtml, /id="allowlist-add-btn"/);
  assert.match(indexHtml, /id="allowlist-list"/);

  // Blocklist
  assert.match(indexHtml, /id="blocklist-section"/);
  assert.match(indexHtml, /id="blocklist-input"/);
  assert.match(indexHtml, /id="blocklist-add-btn"/);
  assert.match(indexHtml, /id="blocklist-list"/);

  // Status
  assert.match(indexHtml, /id="settings-status-mode"/);
  assert.match(indexHtml, /id="settings-status-allowlist"/);
  assert.match(indexHtml, /id="settings-status-blocklist"/);
  assert.match(indexHtml, /id="settings-status-user"/);
});

test('settings.js module registers SafetySettings API on window', () => {
  assert.match(settingsJs, /window\.SafetySettings/);
  assert.match(settingsJs, /canKill/);
  assert.match(settingsJs, /isPortAllowed/);
  assert.match(settingsJs, /getState/);
  assert.match(settingsJs, /refresh/);

  // API calls
  assert.match(settingsJs, /fetchSafetyStatus/);
  assert.match(settingsJs, /\/api\/safety/);
  assert.match(settingsJs, /\/api\/safety\/mode/);
  assert.match(settingsJs, /\/api\/safety\/allowlist/);
  assert.match(settingsJs, /\/api\/safety\/blocklist/);
});

test('settings.js mode selector handles all three modes', () => {
  assert.match(settingsJs, /read-only/);
  assert.match(settingsJs, /allowlist/);
  assert.match(settingsJs, /blocklist/);
  assert.match(settingsJs, /setMode/);
  assert.match(settingsJs, /manageAllowlist/);
  assert.match(settingsJs, /manageBlocklist/);
});

test('settings.js renders allowlist and blocklist items dynamically', () => {
  assert.match(settingsJs, /renderAllowlist/);
  assert.match(settingsJs, /renderBlocklist/);
  assert.match(settingsJs, /allowlist-item/);
  assert.match(settingsJs, /blocklist-item/);
  assert.match(settingsJs, /btn-list-remove/);
  assert.match(settingsJs, /data-action="remove-allowlist"/);
  assert.match(settingsJs, /data-action="remove-blocklist"/);
});

test('app.js exposes showToast globally for settings.js', () => {
  assert.match(appJs, /window\.showToast = showToast/);
});

test('app.js checks read-only mode and disables kill buttons accordingly', () => {
  assert.match(appJs, /isReadOnlyMode/);
  assert.match(appJs, /window\.SafetySettings/);
  assert.match(appJs, /canKill/);
  assert.match(appJs, /killDisabled = isAggregate \|\| isSelf \|\| isSystemProcess \|\| isReadOnlyMode/);
  assert.match(appJs, /Server is in read-only mode/);
});

test('app.js adds safety indicator classes to port badges', () => {
  assert.match(appJs, /safetyClass/);
  assert.match(appJs, /window\.SafetySettings\.getState/);
  assert.match(appJs, /badgeClass \+= ' ' \+ safetyClass/);
});

test('CSS includes settings panel, RTL overrides, and safety badge styles', () => {
  // Settings panel
  assert.match(styleCss, /\.settings-panel/);
  assert.match(styleCss, /\.settings-overlay/);
  assert.match(styleCss, /\.settings-header/);
  assert.match(styleCss, /\.settings-body/);
  assert.match(styleCss, /\.settings-section/);

  // Mode selector
  assert.match(styleCss, /\.mode-selector/);
  assert.match(styleCss, /\.mode-option/);
  assert.match(styleCss, /\.badge-mode/);

  // Lists
  assert.match(styleCss, /\.port-list/);
  assert.match(styleCss, /\.port-list-item/);
  assert.match(styleCss, /\.btn-list-remove/);

  // Status grid
  assert.match(styleCss, /\.status-grid/);
  assert.match(styleCss, /\.status-row/);

  // Header badge
  assert.match(styleCss, /\.safety-header-badge/);

  // RTL overrides
  assert.match(styleCss, /html\[dir="rtl"\]/);

  // Safety badge classes
  assert.match(styleCss, /\.port-badge\.safe/);
  assert.match(styleCss, /\.port-badge\.protected/);

  // Mobile responsive
  assert.match(styleCss, /@media \(max-width: 640px\)/);
});

test('settings.js is loaded after app.js', () => {
  const appJsIndex = indexHtml.indexOf('app.js');
  const settingsJsIndex = indexHtml.indexOf('settings.js');
  assert.ok(appJsIndex > 0, 'app.js script tag must exist');
  assert.ok(settingsJsIndex > 0, 'settings.js script tag must exist');
  assert.ok(settingsJsIndex > appJsIndex, 'settings.js must be loaded after app.js');
});

test('UI includes performance management and monitoring widgets', () => {
  // Check index.html for CPU, memory and warning banner
  assert.match(indexHtml, /id="metric-cpu-usage"/);
  assert.match(indexHtml, /id="metric-memory-usage"/);
  assert.match(indexHtml, /id="warning-banner"/);
  assert.match(indexHtml, /id="quick-clean-btn"/);
  assert.match(indexHtml, /data-filter="system-resources"/);

  // Check app.js for resource monitoring functions
  assert.match(appJs, /updateSystemUsage/);
  assert.match(appJs, /renderWarningBanner/);
  assert.match(appJs, /fetchSystemProcesses/);
  assert.match(appJs, /renderSystemProcessesTable/);
  assert.match(appJs, /suspendSystemProcess/);
  assert.match(appJs, /resumeSystemProcess/);
});

test('UI shows read-only storage and cache findings', () => {
  assert.match(indexHtml, /id="metric-disk-usage"/);
  assert.match(indexHtml, /id="metric-cache-usage"/);
  assert.match(indexHtml, /id="cache-findings"/);
  assert.match(indexHtml, /id="storage-refresh-btn"/);
  assert.match(appJs, /fetch\('\/api\/system\/storage'/);
  assert.match(appJs, /updateStorageUsage/);
  assert.match(styleCss, /\.storage-findings/);
});

test('port view shows source path, listener scope, and grouped identical commands', () => {
  assert.match(indexHtml, /כתובת האזנה/);
  assert.match(indexHtml, /id="spec-address"/);
  assert.match(indexHtml, /id="spec-source"/);
  assert.match(appJs, /function getFriendlyAppName/);
  assert.match(appJs, /function getSourceInfo/);
  assert.match(appJs, /function getListenerInfo/);
  assert.match(appJs, /function aggregatePorts/);
  assert.match(appJs, /סגירה מרוכזת אינה זמינה/);
});

test('UI supports interactive cache deletion, safety badge, and confirm modal logic', () => {
  assert.match(indexHtml, /id="quick-clean-cache-btn"/);
  assert.match(appJs, /fetch\(['"]\/api\/system\/cache['"]/);
  assert.match(appJs, /fetch\(['"]\/api\/system\/cache\/trash['"]/);
  assert.match(appJs, /function formatCacheBytes/);
  assert.match(appJs, /function openCacheConfirmModal/);
  assert.match(appJs, /cache-badge-safe/);
  assert.match(appJs, /cache-badge-caution/);
  assert.match(appJs, /btn-trash-action/);
  assert.match(appJs, /'confirm-help'/);
  assert.match(appJs, /\.style\.display = 'none'/);
  assert.match(appJs, /\.style\.display = 'block'/);
});


