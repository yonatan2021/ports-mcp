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
  assert.match(appJs, /fetch\('\/api\/system\/disk'/);
  assert.match(appJs, /fetch\('\/api\/system\/cache'/);
  assert.match(appJs, /Promise\.all/);
  assert.match(appJs, /persistentCache\.read\(STORAGE_CACHE_KEY/);
  assert.match(appJs, /updateStorageUsage/);
  assert.match(appJs, /updateDiskUsage/);
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
  // Badge classes are defined in CSS; the live rendering goes through renderCacheGroup → getCacheCategoryCopy
  assert.match(styleCss, /cache-badge-safe/);
  assert.match(styleCss, /cache-badge-caution/);
  // Live rendering uses btn-trash-action class via createCacheItemCard
  assert.match(styleCss, /btn-trash-action/);
  assert.match(appJs, /'confirm-help'/);
  assert.match(appJs, /\.style\.display = 'none'/);
  assert.match(appJs, /\.style\.display = 'block'/);
});


test('cache cleaner groups items in collapsed, accessible safety categories', () => {
  assert.match(indexHtml, /id="cache-groups"/);
  assert.match(appJs, /SAFE_TO_CLEAR/);
  assert.match(appJs, /NEEDS_CONFIRMATION/);
  assert.match(appJs, /SYSTEM_PROTECTED/);
  assert.match(appJs, /function getSafeCacheItems/);
  assert.match(appJs, /function renderCacheGroup/);
  assert.match(appJs, /aria-expanded/);
});

test('cache view renders protected cache subgroups as information only', () => {
  assert.match(appJs, /apple-user/);
  assert.match(appJs, /shared-system/);
  assert.match(appJs, /macos-system/);
  assert.match(appJs, /מטמוני Apple בחשבון המשתמש/);
  assert.match(appJs, /מטמוני מערכת משותפים/);
  assert.match(appJs, /מטמוני macOS מוגנים/);
  assert.match(appJs, /מידע בלבד/);
  assert.match(appJs, /מנוהל על ידי macOS ואינו זמין לניקוי/);
  assert.match(styleCss, /\.cache-protected-subgroup/);
});

test('safe cleanup wizard reviews only backend-safe cache items', () => {
  assert.match(indexHtml, /id="safe-clean-wizard"/);
  assert.match(indexHtml, /role="dialog"/);
  assert.match(indexHtml, /aria-modal="true"/);
  assert.match(appJs, /getSafeCacheItems\(cacheItemsData\)/);
  assert.match(appJs, /הפריטים יועברו לפח האשפה/);
});

test('simple port view uses an accessible compact grouped-list contract', () => {
  assert.match(appJs, /className = 'simple-port-section'/);
  assert.match(appJs, /class="simple-port-section-toggle"/);
  assert.match(appJs, /aria-controls="\$\{category\.id\}-content"/);
  assert.match(appJs, /class="simple-port-list"/);
  assert.match(appJs, /row\.className = `simple-port-row/);
  assert.match(appJs, /class="simple-port-row-meta"/);
  assert.match(appJs, /class="simple-port-row-actions"/);
  assert.match(appJs, /openDetailsModal\(portObj\)/);
  assert.match(appJs, /openConfirmModal\('kill', portObj\)/);
  assert.match(appJs, /const killDisabled = isAggregate \|\| isSelf \|\| isSystemProcess \|\| isReadOnlyMode/);
  assert.match(appJs, /מנהל הפורטים \(פעיל\)/);
  assert.match(appJs, /מוגן על ידי macOS/);
  assert.match(appJs, /target="_blank" rel="noopener noreferrer"/);
});

test('compact grouped-list styles keep rows scannable and responsive', () => {
  assert.match(styleCss, /body\.view-simple \.simple-port-section \{/);
  assert.match(styleCss, /body\.view-simple \.simple-port-list/);
  assert.match(styleCss, /body\.view-simple \.simple-port-row \+ \.simple-port-row/);
  assert.match(styleCss, /grid-template-columns: minmax\(0, 1\.35fr\) minmax\(0, 1fr\) auto/);
  assert.match(styleCss, /\.simple-port-section-toggle:focus-visible/);
  assert.match(styleCss, /\.simple-port-row-actions > \* \{ min-height: 44px;/);
  assert.match(styleCss, /@media \(max-width: 760px\)/);
});

test('suspendSystemProcess sends confirm:true so the suspend actually executes', () => {
  // Extract the suspendSystemProcess function body from app.js
  const match = appJs.match(/async function suspendSystemProcess\(pid\)\s*\{([\s\S]*?)\n\}/);
  assert.ok(match, 'suspendSystemProcess function not found');
  const fnBody = match[1];
  // Must include confirm: true in the fetch body
  assert.match(fnBody, /confirm:\s*true/, 'suspendSystemProcess must send confirm: true — without it the backend returns dryRun: true and the process is never suspended');
  // Must NOT send just { pid } without confirm
  assert.doesNotMatch(fnBody, /JSON\.stringify\(\s*\{\s*pid\s*\}\s*\)/, 'suspendSystemProcess must not send a body that only contains pid (missing confirm: true)');
});

test('filterAndRenderCache has no dead code after its rendering path', () => {
  // The function should not contain an unconditional `return;` followed by more logic
  // (regression test for the dead old flat-row renderer that was left behind)
  const match = appJs.match(/function filterAndRenderCache\(\)([\s\S]*?)\n\}\n\nasync function renderWarningBanner/);
  assert.ok(match, 'filterAndRenderCache function boundary not found');
  const fnBody = match[1];
  // The body must NOT contain a bare `return;` followed by sort/render code
  assert.doesNotMatch(fnBody, /return;\s*\n\s*\/\/ Sort:/, 'filterAndRenderCache must not have dead code after an unconditional return');
});

test('successful cache cleanup bypasses the storage cache before rendering results', () => {
  const wizardMatch = appJs.match(/async function confirmSafeCleanWizard\(\)\s*\{([\s\S]*?)\n\}/);
  assert.ok(wizardMatch, 'confirmSafeCleanWizard function not found');
  assert.match(wizardMatch[1], /await updateStorageUsage\(\{ force: true \}\)/);

  const cacheModalMatch = appJs.match(/function openCacheConfirmModal\(cacheItem\)\s*\{([\s\S]*?)\n\}/);
  assert.ok(cacheModalMatch, 'openCacheConfirmModal function not found');
  assert.match(cacheModalMatch[1], /updateStorageUsage\(\{ force: true \}\)/);
});

test('compact system rows provide pause and resume actions without exposing protected processes', () => {
  const match = appJs.match(/function createSimpleSystemProcessRow\(process\)\s*\{([\s\S]*?)\n\}/);
  assert.ok(match, 'createSimpleSystemProcessRow function not found');
  const fnBody = match[1];
  assert.match(fnBody, /btn-pause-simple/);
  assert.match(fnBody, /btn-resume-simple/);
  assert.match(fnBody, /openSuspendConfirmModal\(process\)/);
  assert.match(fnBody, /resumeSystemProcess\(process\.pid\)/);
  assert.match(fnBody, /simple-port-protected/);
});

test('compact pause and resume controls use the same accessible action sizing as other compact controls', () => {
  assert.match(styleCss, /\.simple-port-pause-btn/);
  assert.match(styleCss, /\.simple-port-pause-btn:not\(:disabled\):hover/);
});

test('suspend requires explicit confirmation before it invokes the suspend API', () => {
  const match = appJs.match(/function openSuspendConfirmModal\(process\)\s*\{([\s\S]*?)\n\}/);
  assert.ok(match, 'openSuspendConfirmModal function not found');
  const fnBody = match[1];
  assert.match(fnBody, /השבתת התהליך עשויה להפסיק עבודה שטרם נשמרה/);
  assert.match(fnBody, /השהה תהליך/);
  assert.match(fnBody, /suspendSystemProcess\(process\.pid\)/);
});

test('the terminate modal restores its own warning after a suspend confirmation is dismissed', () => {
  const match = appJs.match(/function openConfirmModal\(action, portObj\)\s*\{([\s\S]*?)\n\}/);
  assert.ok(match, 'openConfirmModal function not found');
  assert.match(match[1], /סגירת תוכנה השייכת לפורט פעיל שולחת אות סיום/);
});

test('disk metric labels used space consistently with its percentage value', () => {
  assert.match(indexHtml, /<span class="metric-label">דיסק בשימוש:<\/span>/);
  assert.match(appJs, /\$\{disk\.percentage\}% בשימוש/);
});
