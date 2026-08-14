// App State
let portsData = [];
let filteredPorts = [];
let systemProcessesData = [];
let filteredProcesses = [];
let activeFilter = 'all'; // 'all', 'user', 'system', 'system-resources'
let viewMode = localStorage.getItem('viewMode') || 'simple'; // 'simple' or 'detailed'
let searchQuery = '';
let currentSort = { column: 'port', order: 'asc' };
let pollIntervalId = null;
let systemUsageIntervalId = null;
let destructiveActionContext = null;
let appUpdateReleaseUrl = null;
let cacheItemsData = [];
let appUpdateSupported = false;
let lastBackgroundRefreshWarningAt = 0;

function createResourceClient(fetchImpl) {
  const inFlight = new Map();

  function getJson(resourceKey, url, { force = false, options = {} } = {}) {
    const currentRequest = inFlight.get(resourceKey);
    if (currentRequest && !force) return currentRequest.promise;
    if (currentRequest) currentRequest.controller.abort();

    const controller = new AbortController();
    let fetchPromise;
    try {
      fetchPromise = fetchImpl(url, { ...options, signal: controller.signal });
    } catch (error) {
      fetchPromise = Promise.reject(error);
    }

    const entry = { controller, promise: null };
    entry.promise = Promise.resolve(fetchPromise)
      .then(response => {
        if (!response.ok) {
          const error = new Error(`Request failed (${response.status || 'unknown'})`);
          error.status = response.status;
          throw error;
        }
        return response.json();
      })
      .finally(() => {
        if (inFlight.get(resourceKey) === entry) inFlight.delete(resourceKey);
      });
    inFlight.set(resourceKey, entry);
    return entry.promise;
  }

  function abort(resourceKey) {
    const currentRequest = inFlight.get(resourceKey);
    if (currentRequest) currentRequest.controller.abort();
  }

  function abortAll() {
    for (const request of inFlight.values()) request.controller.abort();
  }

  return { getJson, abort, abortAll };
}

function createViewPoller({ interval, isVisible, isViewActive, task }) {
  let timeoutId = null;
  let runningPromise = null;
  let stopped = true;

  function canRun() {
    return isVisible() && isViewActive();
  }

  function runNow() {
    if (!canRun()) return Promise.resolve(false);
    if (runningPromise) return runningPromise;

    let taskPromise;
    try {
      taskPromise = task();
    } catch (error) {
      taskPromise = Promise.reject(error);
    }

    runningPromise = Promise.resolve(taskPromise)
      .then(() => true)
      .finally(() => { runningPromise = null; });
    return runningPromise;
  }

  function schedule() {
    if (stopped || timeoutId !== null) return;
    timeoutId = setTimeout(() => {
      timeoutId = null;
      runNow().catch(error => {
        if (error?.name !== 'AbortError') console.warn('Background refresh failed:', error);
      }).finally(schedule);
    }, interval);
  }

  function start() {
    stopped = false;
    schedule();
  }

  function stop() {
    stopped = true;
    if (timeoutId !== null) clearTimeout(timeoutId);
    timeoutId = null;
  }

  return { start, stop, runNow };
}

// Activity Monitor tab filter state
let activityFilters = {
  cpu: { query: '', filter: 'all' },
  memory: { query: '', filter: 'all' },
  energy: { query: '', filter: 'all' },
  disk: { query: '', filter: 'all' }
};

// Cache state variables
let activeCacheFilter = 'all'; // 'all', 'SAFE_TO_CLEAR', 'NEEDS_CONFIRMATION', 'SYSTEM_PROTECTED'
let cacheSizeFilterVal = 'all'; // 'all', '100mb', '1gb'
let cacheSearchQuery = '';
let safeCleanWizardStep = 1;
let safeCleanWizardReturnFocus = null;
const POLL_INTERVAL = 10000; // 10 seconds
const SYSTEM_USAGE_INTERVAL = 8000; // 8 seconds
let lastPortsRenderFingerprint = '';
let lastProcessesRenderFingerprint = '';
const STORAGE_CACHE_KEY = 'ports-mcp-storage-cache-v1';
const STORAGE_CACHE_TTL_MS = 300_000;
const UPDATE_CACHE_KEY = 'ports-mcp-app-update-cache-v1';
const UPDATE_CACHE_TTL_MS = 86_400_000;
const FOCUS_MODE_STORAGE_KEY = 'ports-mcp-focus-mode';
const persistentCache = window.PersistentCache.createPersistentCache();
const prefersReducedMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const resourceClient = createResourceClient(window.fetch.bind(window));
const ACTIVITY_TABS = new Set(['cpu', 'memory', 'energy', 'disk']);
const getActiveTab = () => document.documentElement.dataset.activeTab || localStorage.getItem('activeTab') || 'ports';
const activeViewPoller = createViewPoller({
  interval: POLL_INTERVAL,
  isVisible: () => !document.hidden,
  isViewActive: () => getActiveTab() !== 'cache',
  task: () => refreshCurrentView({ silent: true })
});
const systemUsagePoller = createViewPoller({
  interval: SYSTEM_USAGE_INTERVAL,
  isVisible: () => !document.hidden,
  isViewActive: () => getActiveTab() === 'ports',
  task: updateSystemUsage
});

// Self Port detection based on the loaded URL
const selfPort = parseInt(window.location.port, 10) || 9999;

// Electron & macOS environment detection
if (window.portManager?.isElectron) {
  document.documentElement.classList.add('is-electron');
  if (window.portManager?.platform === 'darwin' || navigator.platform.includes('Mac')) {
    document.documentElement.classList.add('is-mac');
  }
} else if (navigator.platform.includes('Mac')) {
  document.documentElement.classList.add('is-mac');
}

// Dictionary of common ports with descriptions in Hebrew
const PORT_DESCRIPTIONS = {
  22: 'גישה מרחוק מאובטחת (SSH)',
  53: 'שירות שמות מתחם (DNS)',
  80: 'שרת אינטרנט לא מאובטח (HTTP)',
  123: 'סנכרון זמן מערכת (NTP)',
  443: 'שרת אינטרנט מאובטח (HTTPS)',
  3000: 'שרת פיתוח מקומי (React/Node.js)',
  3306: 'בסיס נתונים MySQL',
  5000: 'שירות AirPlay / שרת פיתוח Flask',
  5173: 'שרת פיתוח מקומי (Vite)',
  5432: 'בסיס נתונים PostgreSQL',
  6379: 'מסד נתונים בזיכרון Redis',
  7000: 'שירות מערכת macOS Control Center / AirPlay',
  8000: 'שרת פיתוח מקומי (Python/Django)',
  8080: 'שרת פיתוח מקומי חלופי',
  9000: 'שרת פיתוח מקומי / PHP-FPM',
  9200: 'בסיס נתונים Elasticsearch',
  27017: 'בסיס נתונים MongoDB'
};

// Dictionary of common process names and their Hebrew descriptions / friendly names
const PROCESS_TRANSLATIONS = {
  'node': 'Node.js — שרת פיתוח',
  'python': 'פייתון — שרת פיתוח / כלי מערכת',
  'python3': 'פייתון — שרת פיתוח / כלי מערכת',
  'postgres': 'מסד נתונים PostgreSQL',
  'postmaster': 'מסד נתונים PostgreSQL',
  'mongod': 'מסד נתונים MongoDB',
  'redis-server': 'מסד נתונים בזיכרון Redis',
  'mysql': 'מסד נתונים MySQL',
  'mysqld': 'מסד נתונים MySQL',
  'nginx': 'שרת אינטרנט Nginx',
  'httpd': 'שרת אינטרנט Apache',
  'apache': 'שרת אינטרנט Apache',
  'git': 'מערכת ניהול גרסאות Git',
  'ruby': 'רובי — שרת פיתוח',
  'go': 'יישום Go',
  'java': 'שירות Java — שרת פיתוח',
  'docker': 'סביבת Docker (מכולות)',
  'dockerd': 'סביבת Docker (מכולות)',
  'com.docker.backend': 'מנגנון הליבה של Docker',
  'chrome': 'דפדפן Google Chrome',
  'google chrome': 'דפדפן Google Chrome',
  'safari': 'דפדפן Safari',
  'firefox': 'דפדפן Firefox',
  'vscode': 'עורך הקוד VS Code',
  'code': 'עורך הקוד VS Code',
  'cursor': 'עורך הקוד Cursor',
  'slack': 'אפליקציית Slack',
  'spotify': 'נגן המוזיקה Spotify',
  'electron': 'אפליקציית Electron',
  'mdnsresponder': 'שירות Bonjour (גילוי התקנים ברשת)',
  'dsaccess': 'ניהול הרשאות ספריה',
  'configd': 'תצורת רשת macOS',
  'syslogd': 'שירות רישום יומני מערכת',
  'launchd': 'מנהל השירותים הראשי של macOS (launchd)',
  'identityservicesd': 'שירותי זיהוי של Apple (iMessage/FaceTime)',
  'airportd': 'ניהול רשתות אלחוטיות (Wi-Fi)',
  'sharingd': 'שירות שיתוף קבצים ו-AirDrop',
  'bluetoothd': 'שירות בלוטות\' (Bluetooth)',
  'locationd': 'שירותי מיקום של macOS',
  'cfprefsd': 'ניהול העדפות יישומים (Preferences)',
  'distnoted': 'הפצת התראות בין תהליכים',
  'tccd': 'בקרת פרטיות ואבטחה (מצלמה/מיקרופון)',
  'softwareupdated': 'שירות עדכוני תוכנה של macOS',
  'cloudd': 'שירות סנכרון iCloud',
  'timed': 'סנכרון שעון המערכת',
  'powerd': 'ניהול צריכת חשמל ושינה',
  'windowserver': 'מנהל התצוגה והחלונות של macOS',
  'hidd': 'שירות התקני קלט (מקלדת ועכבר)',
  'coreaudiod': 'מנגנון השמע של macOS',
  'cupsd': 'ניהול מדפסות (CUPS)'
};

function getFriendlyAppName(portObj) {
  const command = portObj.commandLine || '';
  const appMatch = command.match(/\/([^/]+)\.app\/Contents\/MacOS\//);
  if (appMatch) return appMatch[1];

  const scriptMatch = command.match(/(?:^|\s)(?:node|python3?|ruby)\s+(\S+)/);
  let baseName = '';
  if (scriptMatch && !scriptMatch[1].startsWith('-')) {
    baseName = scriptMatch[1].split('/').pop();
  }

  const pName = (portObj.processName || '').toLowerCase();
  if (PROCESS_TRANSLATIONS[pName]) {
    return PROCESS_TRANSLATIONS[pName];
  }

  if (baseName) {
    const baseLower = baseName.toLowerCase();
    if (PROCESS_TRANSLATIONS[baseLower]) {
      return PROCESS_TRANSLATIONS[baseLower];
    }
    return baseName;
  }

  if (/^language[_-]/i.test(portObj.processName || '')) return 'שירות שפה של סביבת פיתוח';

  return portObj.processName || 'תהליך לא מזוהה';
}

function matchSmartQuery(item, query, isPortObj = true) {
  if (!query) return true;
  query = query.toLowerCase().trim();

  // Basic direct text match fields
  const pidStr = String(item.pid || '');
  const name = (item.processName || '').toLowerCase();
  const cmd = (item.commandLine || '').toLowerCase();
  const user = (item.user || '').toLowerCase();

  let directMatch = pidStr.includes(query) ||
                    name.includes(query) ||
                    cmd.includes(query) ||
                    user.includes(query);

  if (isPortObj) {
    const portStr = String(item.port || '');
    const source = getSourceInfo(item).path.toLowerCase();
    const listener = getListenerInfo(item).label.toLowerCase();
    const appFriendlyName = getFriendlyAppName(item).toLowerCase();
    const portDesc = (PORT_DESCRIPTIONS[item.port] || '').toLowerCase();

    directMatch = directMatch ||
                  portStr.includes(query) ||
                  source.includes(query) ||
                  listener.includes(query) ||
                  appFriendlyName.includes(query) ||
                  portDesc.includes(query);
  }

  if (directMatch) return true;

  // Synonym maps in Hebrew
  const synonyms = {
    'דפדפן': ['chrome', 'google chrome', 'safari', 'firefox', 'browser', 'internet', 'אינטרנט'],
    'אינטרנט': ['chrome', 'google chrome', 'safari', 'firefox', 'browser', 'http', 'https', '80', '443'],
    'פיתוח': ['node', 'npm', 'python', 'vite', 'ruby', 'go', '3000', '5173', '8000', '8080', '9000', 'local', 'localhost'],
    'שרת': ['node', 'npm', 'python', 'vite', 'ruby', 'go', '3000', '5173', '8000', '8080', '9000', 'http', 'https'],
    'בסיס נתונים': ['postgres', 'pg', 'mysql', 'redis', 'mongo', 'sql', 'db', 'postmaster', 'mysqld', 'mongod'],
    'מסד נתונים': ['postgres', 'pg', 'mysql', 'redis', 'mongo', 'sql', 'db', 'postmaster', 'mysqld', 'mongod'],
    'דאטהבייס': ['postgres', 'pg', 'mysql', 'redis', 'mongo', 'sql', 'db', 'postmaster', 'mysqld', 'mongod'],
    'מערכת': ['system', 'macos', 'launchd', 'windowserver', 'mdnsresponder', 'cfprefsd', 'tccd', 'cloudd', 'locationd', 'sharingd'],
    'מוגן': ['system', 'macos', 'launchd', 'windowserver', 'mdnsresponder', 'cfprefsd', 'tccd', 'cloudd', 'locationd', 'sharingd', 'self', '9999']
  };

  for (const [key, list] of Object.entries(synonyms)) {
    if (key.includes(query) || query.includes(key)) {
      for (const keyword of list) {
        if (name.includes(keyword) || cmd.includes(keyword) || (isPortObj && String(item.port).includes(keyword))) {
          return true;
        }
      }
    }
  }

  return false;
}

function assessProcessRisk(portObj) {
  const portNumber = Number(portObj.port);
  const processName = (portObj.processName || '').toLowerCase();
  const isSystemProcess = portObj.isSystem === true;
  const isSelf = portNumber === selfPort;

  // 1. High Risk
  if (isSelf) {
    return {
      level: 'high',
      badgeClass: 'badge-high',
      label: 'סיכון גבוה (הגנה עצמית)',
      explanation: 'זהו שרת מנהל הפורטים עצמו. סגירתו תפסיק את פעולת הממשק ותנתק את החיבור הנוכחי.'
    };
  }

  if (isSystemProcess) {
    return {
      level: 'high',
      badgeClass: 'badge-high',
      label: 'סיכון גבוה (תהליך מערכת)',
      explanation: 'תהליך מערכת חיוני של macOS. סגירתו עלולה לגרום לקריסת שירותים, חוסר יציבות זמני או הפעלה מחדש של המחשב.'
    };
  }

  const isDb = processName.includes('postgres') || processName.includes('pg') || processName.includes('mysql') ||
               processName.includes('redis') || processName.includes('mongo') || processName.includes('elastic') ||
               processName.includes('sql') || processName.includes('docker') || processName.includes('dockerd') ||
               [3306, 5432, 6379, 27017, 9200].includes(portNumber);

  if (isDb) {
    return {
      level: 'high',
      badgeClass: 'badge-high',
      label: 'סיכון גבוה (מסד נתונים)',
      explanation: 'מסד נתונים או שירות אחסון מידע פעיל. סגירה פתאומית עלולה לגרום לאובדן מידע שלא נשמר או לפגוע בקבצי המערכת של מסד הנתונים.'
    };
  }

  // 2. Medium Risk
  const isApp = processName.includes('chrome') || processName.includes('firefox') || processName.includes('safari') ||
                processName.includes('browser') || processName.includes('slack') || processName.includes('spotify') ||
                processName.includes('electron') || processName.includes('discord');

  if (isApp) {
    return {
      level: 'medium',
      badgeClass: 'badge-medium',
      label: 'סיכון בינוני (תוכנת משתמש)',
      explanation: 'תוכנת משתמש פעילה. סגירת התהליך תגרום לסגירה מיידית של האפליקציה (למשל הדפדפן או סלאק). ודאו שכל העבודה שלכם שמורה.'
    };
  }

  // 3. Low Risk
  const isDev = [80, 443, 3000, 5000, 5173, 8000, 8080, 9000].includes(portNumber) ||
                processName.includes('node') || processName.includes('npm') || processName.includes('python') ||
                processName.includes('vite') || processName.includes('ruby') || processName.includes('go');

  if (isDev) {
    return {
      level: 'low',
      badgeClass: 'badge-low',
      label: 'סיכון נמוך (שרת פיתוח)',
      explanation: 'שרת פיתוח מקומי או אפליקציה אישית. סגירתו בטוחה לחלוטין ולא תשפיע על פעילות המערכת.'
    };
  }

  // Default fallback
  return {
    level: 'medium',
    badgeClass: 'badge-medium',
    label: 'סיכון בינוני',
    explanation: 'תהליך ריצה כללי. מומלץ לוודא שאינכם זקוקים לשירות זה לפני סגירתו.'
  };
}

function getSourceInfo(portObj) {
  const command = portObj.commandLine || '';
  const appMatch = command.match(/(.+?\.app)(?:\/Contents\/MacOS\/.*)?(?:\s|$)/);
  const scriptMatch = command.match(/(?:^|\s)(?:node|python3?|ruby)\s+(\S+)/);
  const workingDirectory = portObj.workingDirectory || '';

  if (workingDirectory && workingDirectory !== '/' && scriptMatch && !scriptMatch[1].startsWith('/')) {
    return { label: 'קובץ בפרויקט', path: `${workingDirectory.replace(/\/$/, '')}/${scriptMatch[1]}` };
  }
  if (appMatch) return { label: 'יישום macOS', path: appMatch[1] };
  if (command.startsWith('/')) return { label: 'קובץ הפעלה', path: command.split(/\s+/)[0] };
  if (workingDirectory && workingDirectory !== '/') return { label: 'תיקיית עבודה', path: workingDirectory };
  return { label: 'נתיב לא זמין מהמערכת', path: command || 'לא זמין' };
}

function getListenerInfo(portObj) {
  const addresses = portObj.addresses || [portObj.address];
  const address = addresses[0] || '';
  if (/^(?:127\.0\.0\.1|\[::1\]|localhost):/.test(address)) {
    return { label: 'מקומי בלבד' };
  }
  if (/^(?:\*|0\.0\.0\.0|\[::\]):/.test(address)) {
    return { label: 'כל כתובות המחשב' };
  }
  return { label: 'כתובת מסוימת' };
}

// DOM Elements
const elements = {
  tableBody: document.getElementById('ports-table-body'),
  refreshBtn: document.getElementById('refresh-btn'),
  refreshStatus: document.getElementById('refresh-status'),
  focusModeBtn: document.getElementById('focus-mode-btn'),
  quickActionSearch: document.getElementById('quick-action-search'),
  quickActionResolve: document.getElementById('quick-action-resolve'),
  searchInput: document.getElementById('search-input'),
  filterTabs: document.querySelectorAll('.filter-tab'),
  emptyState: document.getElementById('empty-state'),
  toastContainer: document.getElementById('toast-container'),
  uiLiveRegion: document.getElementById('ui-live-region'),

  // Info Hub Modal Selectors
  infoModal: document.getElementById('info-modal'),
  infoCloseBtn: document.getElementById('info-close-btn'),
  infoOkBtn: document.getElementById('info-ok-btn'),
  infoTriggerBtn: document.getElementById('info-trigger-btn'),
  portResolver: document.getElementById('port-resolver'),

  // Navigation tab inline badges
  tabBadgePorts: document.getElementById('tab-badge-ports'),
  tabBadgeCache: document.getElementById('metric-cache-usage'),

  // Persistent System Status Bar elements
  statusRingCpu: document.getElementById('status-ring-cpu'),
  statusTextCpu: document.getElementById('metric-cpu-usage'),
  statusRingMemory: document.getElementById('status-ring-memory'),
  statusTextMemory: document.getElementById('metric-memory-usage'),
  statusTextDisk: document.getElementById('metric-disk-usage'),
  statusTextConnections: document.getElementById('status-text-connections'),

  // Legacy elements redirect (keeps app compatibility)
  metricActiveCount: document.getElementById('status-text-connections') || document.createElement('div'),
  metricUserCount: document.createElement('div'), // dummy
  metricSystemCount: document.createElement('div'), // dummy
  metricCpuUsage: document.getElementById('metric-cpu-usage') || document.createElement('div'),
  metricCpuDetail: document.createElement('div'), // dummy
  cpuBar: document.createElement('div'), // dummy
  metricMemoryUsage: document.getElementById('metric-memory-usage') || document.createElement('div'),
  metricMemoryDetail: document.createElement('div'), // dummy
  memoryBar: document.createElement('div'), // dummy
  metricDiskUsage: document.getElementById('metric-disk-usage') || document.createElement('div'),
  metricDiskDetail: document.createElement('div'), // dummy
  metricCacheUsage: document.createElement('div'), // handled directly

  cacheFindings: document.getElementById('cache-findings'),
  storageRefreshBtn: document.getElementById('storage-refresh-btn'),
  cacheGroups: document.getElementById('cache-groups'),
  cacheSummarySafeSize: document.getElementById('cache-summary-safe-size'),
  cacheSummaryTotalSize: document.getElementById('cache-summary-total-size'),
  safeCleanWizard: document.getElementById('safe-clean-wizard'),
  safeCleanWizardProgress: document.getElementById('safe-clean-wizard-progress'),
  safeCleanWizardDescription: document.getElementById('safe-clean-wizard-description'),
  safeCleanWizardItems: document.getElementById('safe-clean-wizard-items'),
  safeCleanWizardBack: document.getElementById('safe-clean-wizard-back'),
  safeCleanWizardCancel: document.getElementById('safe-clean-wizard-cancel'),
  safeCleanWizardNext: document.getElementById('safe-clean-wizard-next'),
  safeCleanWizardClose: document.getElementById('safe-clean-wizard-close'),
  resultsCount: document.getElementById('results-count'),
  currentViewTitle: document.getElementById('current-view-title'),

  // App information
  currentVersion: document.getElementById('current-version'),
  updateStatus: document.getElementById('update-status'),
  updateButton: document.getElementById('update-button'),
  copyrightYear: document.getElementById('copyright-year'),

  // Warning Banner
  warningBanner: document.getElementById('warning-banner'),
  warningMessage: document.getElementById('warning-message'),
  quickCleanBtn: document.getElementById('quick-clean-btn'),
  warningSuggestions: document.getElementById('warning-suggestions'),

  // Confirm Modal
  confirmModal: document.getElementById('confirm-modal'),
  modalTitle: document.getElementById('modal-title'),
  modalDesc: document.getElementById('modal-desc'),
  modalConfirmBtn: document.getElementById('modal-confirm-btn'),
  modalCancelBtn: document.getElementById('modal-cancel-btn'),
  modalCloseBtn: document.getElementById('modal-close-btn'),
  confirmPidInput: document.getElementById('confirm-pid-input'),
  confirmUnderstandCheckbox: document.getElementById('confirm-understand-checkbox'),
  confirmRequiredPid: document.getElementById('confirm-required-pid'),
  previewPort: document.getElementById('preview-port'),
  previewProcess: document.getElementById('preview-process'),
  previewPid: document.getElementById('preview-pid'),
  previewCommand: document.getElementById('preview-command'),

  // Details Modal
  detailsModal: document.getElementById('details-modal'),
  detailsCloseBtn: document.getElementById('details-close-btn'),
  detailsOkBtn: document.getElementById('details-ok-btn'),
  btnCopyCommand: document.getElementById('btn-copy-command'),
  specPort: document.getElementById('spec-port'),
  specName: document.getElementById('spec-name'),
  specPid: document.getElementById('spec-pid'),
  specUser: document.getElementById('spec-user'),
  specAddress: document.getElementById('spec-address'),
  specSource: document.getElementById('spec-source'),
  specProtocol: document.getElementById('spec-protocol'),
  specType: document.getElementById('spec-type'),
  specCpu: document.getElementById('spec-cpu'),
  specMemory: document.getElementById('spec-memory'),
  specCommand: document.getElementById('spec-command'),

  // Sidebar Tabs & Views
  tabBtnPorts: document.getElementById('tab-btn-ports'),
  tabBtnCache: document.getElementById('tab-btn-cache'),
  viewPorts: document.getElementById('view-ports'),
  viewCache: document.getElementById('view-cache'),

  // Cache Advanced Filters
  cacheSearchInput: document.getElementById('cache-search-input'),
  cacheSizeFilter: document.getElementById('cache-size-filter'),
  cacheFilterTabs: document.querySelectorAll('.cache-filter-tab'),
  cacheResultsCount: document.getElementById('cache-results-count'),
  cacheEmptyState: document.getElementById('cache-empty-state'),

  // Recent Actions Panel
  recentActionsPanel: document.getElementById('recent-actions-panel'),
  recentActionsToggle: document.getElementById('recent-actions-toggle'),
  recentActionsContent: document.getElementById('recent-actions-content'),
  recentActionsList: document.getElementById('recent-actions-list'),
  recentActionsBadge: document.getElementById('recent-actions-badge'),
  clearActionsBtn: document.getElementById('clear-actions-btn')
};

// --- INITIALIZATION ---
document.addEventListener('DOMContentLoaded', () => {
  setupEventListeners();
  setFocusMode(localStorage.getItem(FOCUS_MODE_STORAGE_KEY) === 'true', { announce: false });
  fetchAppInfo();
  setupRecentActions();

  const savedTab = localStorage.getItem('activeTab') || 'ports';
  switchTab(savedTab);
});

function switchTab(tabId) {
  const allTabs = ['ports', 'cpu', 'memory', 'energy', 'disk', 'cache'];
  const targetTab = allTabs.includes(tabId) ? tabId : 'ports';
  const isNewTab = localStorage.getItem('activeTab') !== targetTab;

  allTabs.forEach(t => {
    const btn = document.getElementById(`tab-btn-${t}`);
    if (btn) btn.classList.toggle('active', t === targetTab);
    const view = document.getElementById(`view-${t}`);
    if (view) view.classList.toggle('hidden', t !== targetTab);
  });

  localStorage.setItem('activeTab', targetTab);
  document.documentElement.dataset.activeTab = targetTab;

  if (targetTab === 'ports') {
    fetchPorts({ force: true });
    startPolling();
    updateSystemUsage({ force: true });
    startSystemUsagePolling();
  } else if (targetTab === 'cache') {
    stopPolling();
    stopSystemUsagePolling();
    updateStorageUsage();
  } else {
    stopSystemUsagePolling();
    fetchActivityMonitorTab(targetTab, { force: true });
    startPolling();
  }

  const tabLabels = {
    ports: 'רשת ופורטים',
    cpu: 'מעבד',
    memory: 'זיכרון',
    energy: 'צריכה',
    disk: 'כונן',
    cache: 'ניקוי Cache'
  };

  if (isNewTab) announceUiStatus(`עברת לתצוגת ${tabLabels[targetTab] || targetTab}`);
}

function announceUiStatus(message) {
  if (elements.uiLiveRegion) elements.uiLiveRegion.textContent = message;
}

function setButtonBusy(button, isBusy, statusMessage) {
  if (!button) return;
  button.classList.toggle('is-busy', isBusy);
  button.toggleAttribute('aria-busy', isBusy);
  button.disabled = isBusy;
  if (statusMessage) announceUiStatus(statusMessage);
}

function setRefreshState(isRefreshing, message = '') {
  document.documentElement.classList.toggle('is-refreshing', isRefreshing);
  if (elements.refreshStatus) {
    elements.refreshStatus.textContent = message || (isRefreshing ? 'מעדכן נתונים…' : 'הנתונים מעודכנים');
  }
}

function markDataFresh() {
  elements.tableBody?.classList.remove('data-refreshed');
  requestAnimationFrame(() => elements.tableBody?.classList.add('data-refreshed'));
}

function setFocusMode(enabled, { announce = true } = {}) {
  document.body.classList.toggle('focus-mode', enabled);
  if (elements.focusModeBtn) {
    elements.focusModeBtn.setAttribute('aria-pressed', String(enabled));
    elements.focusModeBtn.setAttribute('aria-label', enabled ? 'צא ממצב ריכוז' : 'הפעל מצב ריכוז');
    elements.focusModeBtn.innerHTML = `<span aria-hidden="true">${enabled ? '◑' : '◐'}</span> ${enabled ? 'יציאה מריכוז' : 'מצב ריכוז'}`;
  }
  localStorage.setItem(FOCUS_MODE_STORAGE_KEY, String(enabled));
  if (announce) announceUiStatus(enabled ? 'מצב ריכוז פעיל: המדדים וההסברים צומצמו' : 'יצאת ממצב ריכוז');
}

function setResolverOpen(isOpen, { focusInput = false } = {}) {
  const resolver = elements.portResolver;
  const toggle = elements.quickActionResolve;
  if (!resolver || !toggle) return;
  resolver.classList.toggle('hidden', !isOpen);
  resolver.hidden = !isOpen;
  toggle.setAttribute('aria-expanded', String(isOpen));
  if (focusInput && isOpen) document.getElementById('quick-resolve-input')?.focus({ preventScroll: true });
}

function renderTableSkeleton(label = 'טוען נתונים עדכניים…') {
  const rows = Array.from({ length: 5 }, () => `
    <tr class="table-skeleton" aria-hidden="true">
      <td><span class="skeleton-line skeleton-port"></span></td>
      <td><span class="skeleton-line skeleton-title"></span><span class="skeleton-line skeleton-subtitle"></span></td>
      <td class="column-pid"><span class="skeleton-line skeleton-short"></span></td>
      <td class="column-advanced"><span class="skeleton-line skeleton-short"></span></td>
      <td class="column-advanced"><span class="skeleton-line skeleton-short"></span></td>
      <td><span class="skeleton-line skeleton-short"></span></td>
      <td class="column-command"><span class="skeleton-line skeleton-title"></span></td>
      <td><span class="skeleton-line skeleton-action"></span></td>
    </tr>`).join('');
  elements.tableBody.innerHTML = `
    <tr class="sr-only"><td colspan="8">${label}</td></tr>
    ${rows}
  `;
}

async function fetchAppInfo() {
  if (elements.copyrightYear) {
    elements.copyrightYear.textContent = String(new Date().getFullYear());
  }

  const cachedInfo = persistentCache.read(UPDATE_CACHE_KEY, UPDATE_CACHE_TTL_MS);
  if (cachedInfo) {
    renderAppInfo(cachedInfo);
    return;
  }

  const staleInfo = persistentCache.read(UPDATE_CACHE_KEY, Infinity);
  if (staleInfo) renderAppInfo(staleInfo);

  try {
    const response = await fetch('/api/app-info');
    if (!response.ok) throw new Error('App info unavailable');
    const info = await response.json();
    persistentCache.write(UPDATE_CACHE_KEY, info);
    renderAppInfo(info);
  } catch (_error) {
    elements.updateStatus.textContent = 'לא ניתן לבדוק עדכונים כרגע';
  }
}

function renderAppInfo(info) {
  elements.currentVersion.textContent = info.currentVersion || '-';
  appUpdateReleaseUrl = typeof info.releaseUrl === 'string' ? info.releaseUrl : null;
  appUpdateSupported = info.updateSupported === true && typeof window.portManager?.applyUpdate === 'function';

  if (info.updateAvailable) {
    elements.updateStatus.textContent = `עדכון זמין: גרסה ${info.latestVersion}`;
    elements.updateStatus.classList.add('available');
    elements.updateButton.textContent = appUpdateSupported ? 'עדכן עכשיו' : 'פתח דף הורדה';
    elements.updateButton.classList.remove('hidden');
    return;
  }

  elements.updateStatus.textContent = info.latestVersion ? 'הגרסה מעודכנת' : 'לא ניתן לבדוק עדכונים כרגע';
}

async function applyAppUpdate() {
  if (!appUpdateSupported) {
    if (appUpdateReleaseUrl) window.open(appUpdateReleaseUrl, '_blank', 'noopener,noreferrer');
    return;
  }

  elements.updateButton.disabled = true;
  elements.updateButton.textContent = 'מעדכן…';
  elements.updateStatus.textContent = 'מוריד ומאמת את העדכון…';

  try {
    const body = await window.portManager.applyUpdate();
    if (!body?.ok || !body?.handedOff) throw new Error('Update handoff failed');

    elements.updateStatus.textContent = 'העדכון אומת, מפעיל מחדש...';
    elements.updateButton.classList.add('hidden');
  } catch (error) {
    console.error('Could not apply app update:', error);
    elements.updateStatus.textContent = 'העדכון נכשל, ניתן לנסות שוב';
    elements.updateStatus.classList.add('available');
    elements.updateButton.disabled = false;
    elements.updateButton.textContent = 'נסה שוב';
    showToast(`העדכון נכשל: ${error.message}`, 'error');
  }
}

// --- RECENT ACTIONS LOG ---
const RECENT_ACTIONS_KEY = 'ports-mcp-recent-actions';

function getRecentActions() {
  try {
    return JSON.parse(localStorage.getItem(RECENT_ACTIONS_KEY)) || [];
  } catch (e) {
    return [];
  }
}

function logRecentAction(type, target, details) {
  const actions = getRecentActions();
  const newAction = {
    type,
    target,
    details,
    timestamp: new Date().toLocaleTimeString('he-IL', { hour: '2-digit', minute: '2-digit', second: '2-digit' })
  };
  actions.unshift(newAction);
  if (actions.length > 8) {
    actions.pop();
  }
  localStorage.setItem(RECENT_ACTIONS_KEY, JSON.stringify(actions));
  renderRecentActions();
}

function renderRecentActions() {
  if (!elements.recentActionsList) return;
  const actions = getRecentActions();

  if (actions.length === 0) {
    if (elements.recentActionsPanel) elements.recentActionsPanel.classList.add('hidden');
    return;
  }

  if (elements.recentActionsPanel) elements.recentActionsPanel.classList.remove('hidden');
  elements.recentActionsList.innerHTML = '';

  if (elements.recentActionsBadge) {
    elements.recentActionsBadge.textContent = actions.length;
    elements.recentActionsBadge.classList.remove('hidden');
  }

  actions.forEach(action => {
    const li = document.createElement('li');
    li.className = 'action-history-item';

    let icon = '⚡';
    let typeName = '';
    if (action.type === 'kill') {
      icon = '🛑';
      typeName = 'סגירת תהליך';
    } else if (action.type === 'pause') {
      icon = '⏸️';
      typeName = 'השהיית תהליך';
    } else if (action.type === 'resume') {
      icon = '▶️';
      typeName = 'המשך תהליך';
    } else if (action.type === 'clean-cache') {
      icon = '🧹';
      typeName = 'ניקוי מהיר של Cache';
    } else if (action.type === 'trash-cache') {
      icon = '🗑️';
      typeName = 'מחיקת Cache';
    }

    li.innerHTML = `
      <div class="action-history-left">
        <span class="action-history-icon">${icon}</span>
        <span class="action-history-text">${typeName}: <b>${escapeHtml(action.target)}</b></span>
        <span style="font-size: var(--font-size-xs); color: var(--text-secondary);">${escapeHtml(action.details)}</span>
      </div>
      <div class="action-history-right">
        <span class="action-history-badge success">בוצע בהצלחה</span>
        <span class="action-history-time">${action.timestamp}</span>
      </div>
    `;
    elements.recentActionsList.appendChild(li);
  });
}

function setupRecentActions() {
  if (!elements.recentActionsToggle || !elements.recentActionsContent) return;

  elements.recentActionsToggle.addEventListener('click', (e) => {
    // Avoid toggling when clicking the "Clear" button
    if (e.target && e.target.id === 'clear-actions-btn') return;

    const isExpanded = elements.recentActionsToggle.getAttribute('aria-expanded') === 'true';
    elements.recentActionsToggle.setAttribute('aria-expanded', !isExpanded);
    elements.recentActionsContent.classList.toggle('hidden', isExpanded);

    const arrow = elements.recentActionsToggle.querySelector('.accordion-arrow');
    if (arrow) {
      arrow.style.transform = isExpanded ? 'rotate(0deg)' : 'rotate(180deg)';
    }
  });

  if (elements.clearActionsBtn) {
    elements.clearActionsBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      localStorage.removeItem(RECENT_ACTIONS_KEY);
      renderRecentActions();
    });
  }

  renderRecentActions();
}

function setupEventListeners() {
  setupViewModeToggle();
  elements.updateButton.addEventListener('click', applyAppUpdate);

  // Refresh button
  elements.refreshBtn.addEventListener('click', () => runManualRefresh());
  elements.storageRefreshBtn.addEventListener('click', async () => {
    setButtonBusy(elements.storageRefreshBtn, true, 'סורק את קבצי ה-Cache…');
    try {
      await updateStorageUsage({ force: true });
      announceUiStatus('סריקת ה-Cache הושלמה');
    } finally {
      setButtonBusy(elements.storageRefreshBtn, false);
    }
  });
  elements.focusModeBtn?.addEventListener('click', () => {
    setFocusMode(!document.body.classList.contains('focus-mode'));
  });
  elements.quickActionResolve?.addEventListener('click', () => {
    const expanded = elements.quickActionResolve.getAttribute('aria-expanded') === 'true';
    setResolverOpen(!expanded, { focusInput: !expanded });
    announceUiStatus(expanded ? 'שחרור הפורט נסגר' : 'הזיני מספר פורט לשחרור');
  });

  // Sidebar Tabs
  ['ports', 'cpu', 'memory', 'energy', 'disk', 'cache'].forEach(tabName => {
    const btn = document.getElementById(`tab-btn-${tabName}`);
    if (btn) {
      btn.addEventListener('click', () => switchTab(tabName));
    }
  });

  const aiSummaryBtn = document.getElementById('ai-summary-btn');
  if (aiSummaryBtn) {
    aiSummaryBtn.addEventListener('click', copyAiSummary);
  }

  ['cpu', 'memory', 'energy', 'disk'].forEach(tabName => {
    const input = document.getElementById(`${tabName}-search-input`);
    if (input) {
      input.addEventListener('input', (e) => {
        const query = e.target.value.toLowerCase().trim();
        activityFilters[tabName].query = query;
        applyActivityFilters(tabName);
      });
    }

    const filterTabsContainer = document.querySelector(`.${tabName}-filter-tabs`);
    if (filterTabsContainer) {
      filterTabsContainer.addEventListener('click', (e) => {
        const btn = e.target.closest('.filter-tab');
        if (!btn) return;
        const filterVal = btn.getAttribute(`data-${tabName}-filter`) || btn.dataset.filter || 'all';
        filterTabsContainer.querySelectorAll('.filter-tab').forEach(b => b.classList.toggle('active', b === btn));
        activityFilters[tabName].filter = filterVal;
        applyActivityFilters(tabName);
      });
    }
  });

  // Global search shortcut (⌘F / Ctrl+F or '/')
  document.addEventListener('keydown', (event) => {
    if ((event.metaKey || event.ctrlKey) && event.code === 'KeyR') {
      event.preventDefault();
      runManualRefresh();
      return;
    }
    if (event.metaKey && event.code === 'Comma') {
      event.preventDefault();
      window.SafetySettings?.open();
      return;
    }
    const e = event;
    if (['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement?.tagName)) return;
    if ((e.metaKey || e.ctrlKey) && (e.key === 'f' || e.key === 'F')) {
      e.preventDefault();
      focusCurrentTabSearch();
    } else if (e.key === '/') {
      e.preventDefault();
      focusCurrentTabSearch();
    }
  });

  setupTouchTabNavigation();

  // Search input
  elements.searchInput.addEventListener('input', (e) => {
    searchQuery = e.target.value.toLowerCase().trim();
    const isPortQuery = /^\d+$/.test(searchQuery);
    const portNumber = Number(searchQuery);
    setResolverOpen(isPortQuery && portNumber >= 1 && portNumber <= 65535);
    applyFilters();
  });

  // Cache Search input
  if (elements.cacheSearchInput) {
    elements.cacheSearchInput.addEventListener('input', (e) => {
      cacheSearchQuery = e.target.value.toLowerCase().trim();
      filterAndRenderCache();
    });
  }

  // Cache Size select filter
  if (elements.cacheSizeFilter) {
    elements.cacheSizeFilter.addEventListener('change', (e) => {
      cacheSizeFilterVal = e.target.value;
      filterAndRenderCache();
    });
  }

  // Cache Safety filter tabs
  if (elements.cacheFilterTabs) {
    elements.cacheFilterTabs.forEach(tab => {
      tab.addEventListener('click', () => {
        elements.cacheFilterTabs.forEach(t => t.classList.remove('active'));
        tab.classList.add('active');
        activeCacheFilter = tab.dataset.filter;
        filterAndRenderCache();
      });
    });
  }

  // Filter tabs
  elements.filterTabs.forEach(tab => {
    tab.addEventListener('click', () => {
      elements.filterTabs.forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      activeFilter = tab.dataset.filter;
      if (activeFilter === 'system-resources') {
        fetchSystemProcesses();
      } else {
        applyFilters();
      }
    });
  });

  // Table headers sorting
  document.querySelectorAll('.ports-table th.sortable').forEach(th => {
    th.addEventListener('click', () => {
      const column = th.dataset.sort;
      const order = currentSort.column === column && currentSort.order === 'asc' ? 'desc' : 'asc';
      currentSort = { column, order };

      // Update header indicators
      document.querySelectorAll('.ports-table th.sortable .sort-indicator').forEach(ind => {
        ind.textContent = '▲';
        ind.style.opacity = '0.3';
      });
      const ind = th.querySelector('.sort-indicator');
      ind.textContent = order === 'asc' ? '▲' : '▼';
      ind.style.opacity = '0.9';

      sortAndRender();
    });
  });

  // Confirm Modal Close
  const closeConfirmModal = () => {
    elements.confirmModal.classList.add('hidden');
    resetDestructiveConfirmation();
    startPolling();
  };
  elements.modalCancelBtn.addEventListener('click', closeConfirmModal);
  elements.modalCloseBtn.addEventListener('click', closeConfirmModal);
  elements.confirmPidInput.addEventListener('input', () => validateDestructiveConfirmation());
  elements.confirmUnderstandCheckbox.addEventListener('change', () => validateDestructiveConfirmation());
  if (elements.confirmRequiredPid) {
    elements.confirmRequiredPid.addEventListener('click', () => {
      const pidVal = elements.confirmRequiredPid.textContent;
      if (pidVal && pidVal !== '-' && pidVal !== '--') {
        elements.confirmPidInput.value = pidVal;
        elements.confirmUnderstandCheckbox.checked = true;
        validateDestructiveConfirmation();
        elements.confirmRequiredPid.classList.add('active-feed');
        setTimeout(() => {
          elements.confirmRequiredPid.classList.remove('active-feed');
        }, 150);
      }
    });
  }
  elements.confirmModal.addEventListener('click', (e) => {
    if (e.target === elements.confirmModal) closeConfirmModal();
  });

  // Quick Clean Cache button
  const quickCleanCacheBtn = document.getElementById('quick-clean-cache-btn');
  if (quickCleanCacheBtn) {
    quickCleanCacheBtn.addEventListener('click', openSafeCleanWizard);
  }

  elements.safeCleanWizardClose?.addEventListener('click', closeSafeCleanWizard);
  elements.safeCleanWizardCancel?.addEventListener('click', closeSafeCleanWizard);
  elements.safeCleanWizardBack?.addEventListener('click', () => {
    if (safeCleanWizardStep > 1) {
      safeCleanWizardStep -= 1;
      renderSafeCleanWizardStep();
    }
  });
  elements.safeCleanWizardNext?.addEventListener('click', async () => {
    if (safeCleanWizardStep < 3) {
      safeCleanWizardStep += 1;
      renderSafeCleanWizardStep();
      return;
    }
    await confirmSafeCleanWizard();
  });
  elements.safeCleanWizard?.addEventListener('click', (event) => {
    if (event.target === elements.safeCleanWizard) closeSafeCleanWizard();
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !elements.safeCleanWizard?.classList.contains('hidden')) {
      closeSafeCleanWizard();
    }
  });

  // Info Hub Modal
  if (elements.infoTriggerBtn) {
    elements.infoTriggerBtn.addEventListener('click', () => {
      elements.infoModal.classList.remove('hidden');
    });
  }
  const closeInfoModal = () => {
    elements.infoModal.classList.add('hidden');
  };
  if (elements.infoCloseBtn) {
    elements.infoCloseBtn.addEventListener('click', closeInfoModal);
  }
  if (elements.infoOkBtn) {
    elements.infoOkBtn.addEventListener('click', closeInfoModal);
  }
  if (elements.infoModal) {
    elements.infoModal.addEventListener('click', (e) => {
      if (e.target === elements.infoModal) closeInfoModal();
    });
  }

  // Details Modal Close
  const closeDetailsModal = () => {
    elements.detailsModal.classList.add('hidden');
    startPolling();
  };
  elements.detailsOkBtn.addEventListener('click', closeDetailsModal);
  elements.detailsCloseBtn.addEventListener('click', closeDetailsModal);
  elements.detailsModal.addEventListener('click', (e) => {
    if (e.target === elements.detailsModal) closeDetailsModal();
  });

  // Educational Widget Toggle
  const eduToggle = document.getElementById('education-toggle');
  const eduContent = document.getElementById('education-content');
  if (eduToggle && eduContent) {
    eduToggle.addEventListener('click', () => {
      const isHidden = eduContent.classList.contains('hidden');
      eduContent.classList.toggle('hidden', !isHidden);
      eduToggle.setAttribute('aria-expanded', isHidden ? 'true' : 'false');
      const arrow = eduToggle.querySelector('.education-arrow');
      if (arrow) {
        arrow.style.transform = isHidden ? 'rotate(180deg)' : 'rotate(0deg)';
      }
    });
    // Keyboard support for accessibility
    eduToggle.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        eduToggle.click();
      }
    });
  }

  // Quick Port Resolver event listener
  const resolveInput = document.getElementById('quick-resolve-input');
  const resolveBtn = document.getElementById('quick-resolve-btn');
  if (resolveBtn && resolveInput) {
    resolveBtn.addEventListener('click', () => {
      const portVal = resolveInput.value.trim();
      if (!portVal) {
        showToast('נא להקליד מספר פורט תקין', 'error');
        return;
      }
      const portNum = parseInt(portVal, 10);
      if (isNaN(portNum) || portNum < 1 || portNum > 65535) {
        showToast('פורט לא תקין. נא להקליד מספר בין 1 ל-65535', 'error');
        return;
      }

      // Look for the port in portsData
      const foundPort = portsData.find(p => Number(p.port) === portNum || (p.ports && p.ports.includes(portNum)));
      if (foundPort) {
        // Open confirm modal directly
        openConfirmModal('kill', foundPort);
        resolveInput.value = '';
      } else {
        showToast(`פורט ${portNum} פנוי לחלוטין כעת! לא נמצא תהליך שמשתמש בו.`, 'success');
      }
    });
    // Add Enter key support
    resolveInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        resolveBtn.click();
      }
    });
  }
}

function setupTouchTabNavigation() {
  let touchStart = null;
  const touchTabOrder = ['ports', 'cpu', 'memory', 'energy', 'disk', 'cache'];
  document.addEventListener('pointerdown', (event) => {
    if (event.pointerType !== 'touch' || event.target.closest('input, textarea, select, button, a, [role="dialog"]')) return;
    touchStart = { x: event.clientX, y: event.clientY };
  }, { passive: true });

  document.addEventListener('pointerup', (event) => {
    if (!touchStart || event.pointerType !== 'touch') return;
    const deltaX = event.clientX - touchStart.x;
    const deltaY = event.clientY - touchStart.y;
    touchStart = null;
    if (Math.abs(deltaX) < 72 || Math.abs(deltaX) < Math.abs(deltaY) * 1.5) return;
    if (!elements.confirmModal.classList.contains('hidden') || !elements.detailsModal.classList.contains('hidden')) return;

    const activeTab = localStorage.getItem('activeTab') || 'ports';
    const currentIndex = touchTabOrder.indexOf(activeTab);
    const isRtl = document.documentElement.dir === 'rtl';
    const direction = (deltaX > 0) === isRtl ? 1 : -1;
    const nextTab = touchTabOrder[currentIndex + direction];
    if (nextTab) switchTab(nextTab);
  }, { passive: true });
}

// --- POLLING LOGIC ---
function startPolling() {
  activeViewPoller.start();
  pollIntervalId = true;
}

function stopPolling() {
  activeViewPoller.stop();
  pollIntervalId = null;
}

function startSystemUsagePolling() {
  systemUsagePoller.start();
  systemUsageIntervalId = true;
}

function stopSystemUsagePolling() {
  systemUsagePoller.stop();
  systemUsageIntervalId = null;
}

function refreshCurrentView({ force = false, silent = false } = {}) {
  const activeTab = getActiveTab();
  if (activeTab === 'ports') {
    const viewRefresh = silent ? fetchPortsSilent({ force }) : fetchPorts({ force });
    return force ? Promise.all([viewRefresh, updateSystemUsage({ force: true })]) : viewRefresh;
  }
  if (activeTab === 'cache') return updateStorageUsage({ force });
  if (ACTIVITY_TABS.has(activeTab)) return fetchActivityMonitorTab(activeTab, { force });
  return Promise.resolve();
}

async function runManualRefresh() {
  setButtonBusy(elements.refreshBtn, true, 'מרענן את התצוגה הנוכחית…');
  setRefreshState(true);
  try {
    await refreshCurrentView({ force: true });
    announceUiStatus('התצוגה עודכנה');
    setRefreshState(false, 'עודכן עכשיו');
  } catch (error) {
    setRefreshState(false, 'לא ניתן לעדכן כרגע');
    throw error;
  } finally {
    setButtonBusy(elements.refreshBtn, false);
  }
}

// Pause all background polling when page/tab is hidden or minimized
document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    stopPolling();
    stopSystemUsagePolling();
  } else {
    const activeTab = getActiveTab();
    if (activeTab !== 'cache') {
      startPolling();
    }
    if (activeTab === 'ports') {
      startSystemUsagePolling();
      refreshCurrentView({ force: true });
    } else if (ACTIVITY_TABS.has(activeTab)) {
      refreshCurrentView({ force: true });
    }
  }
});

// --- DATA DEDUPLICATION LOGIC ---
// Merges IPv4 & IPv6 duplicate rows for the same port and PID
function deduplicatePorts(ports) {
  const grouped = {};
  for (const item of ports) {
    const key = `${item.port}-${item.pid}`;
    if (!grouped[key]) {
      grouped[key] = {
        ...item,
        types: [item.type],
        protocols: [item.protocol]
      };
    } else {
      if (!grouped[key].types.includes(item.type)) {
        grouped[key].types.push(item.type);
      }
      if (!grouped[key].protocols.includes(item.protocol)) {
        grouped[key].protocols.push(item.protocol);
      }
    }
  }
  return Object.values(grouped).map(item => {
    const typeStr = item.types.join(', ');
    const protoStr = item.protocols.join(', ');
    return {
      ...item,
      typeDisplay: `${protoStr} (${typeStr})`
    };
  });
}

// Merge identical commands only after IPv4/IPv6 listeners were merged.
// Each row is a current LISTEN snapshot; closing remains per process, never per group.
function aggregatePorts(ports) {
  const groups = new Map();
  for (const item of ports) {
    const command = item.commandLine || item.processName || '';
    const key = command === 'Unknown command' ? `${command}-${item.pid}` : `${item.user}-${command}`;
    const group = groups.get(key) || { ...item, ports: [], pids: [], addresses: [], cpu: 0, memoryMb: 0 };
    if (!group.ports.includes(item.port)) group.ports.push(item.port);
    if (!group.pids.includes(item.pid)) {
      group.pids.push(item.pid);
      group.cpu += item.cpu || 0;
      group.memoryMb += item.memoryMb || 0;
    }
    if (item.address && !group.addresses.includes(item.address)) group.addresses.push(item.address);
    groups.set(key, group);
  }
  return [...groups.values()].map(group => ({
    ...group,
    ports: group.ports.sort((a, b) => a - b),
    pids: group.pids.sort((a, b) => a - b),
    instanceCount: group.pids.length,
    isAggregate: group.pids.length > 1,
    cpu: parseFloat(group.cpu.toFixed(1)),
    memoryMb: parseFloat(group.memoryMb.toFixed(1)),
  }));
}

// --- DATA FETCHING ---
function handlePortScanState(data) {
  if (data.scan?.state === 'degraded') {
    announceUiStatus(data.scan.warning || 'סריקת הפורטים חלקית. נסה לרענן שוב.');
    showToast(data.scan.warning || 'סריקת הפורטים חלקית. נסה לרענן שוב.', 'warning');
  }
}

async function fetchPorts({ force = true } = {}) {
  if (activeFilter === 'system-resources') {
    return fetchSystemProcesses();
  }

  renderTableSkeleton('סורק פורטים פעילים ב-macOS…');
  lastPortsRenderFingerprint = '';
  elements.emptyState.classList.add('hidden');

  try {
    const data = await resourceClient.getJson('ports', '/api/ports?bypassCache=true', { force });
    portsData = data.ports || [];
    handlePortScanState(data);
    applyFilters();
    markDataFresh();
  } catch (err) {
    if (err?.name === 'AbortError') return;
    console.error(err);
    elements.tableBody.innerHTML = `
      <tr>
        <td colspan="8" class="loading-state" style="color: var(--color-danger)">
          ⚠️ לא מצליח ליצור קשר עם שרת מנהל הפורטים. ודא שהשרת רץ בכתובת <code>http://127.0.0.1:${selfPort}</code> ורענן את הדף.
        </td>
      </tr>
    `;
    showToast('החיבור לשרת אבד. האם שרת מנהל הפורטים עדיין פעיל?', 'error');
  }
}

// Silent refresh in the background (no full loading state)
async function fetchPortsSilent({ force = false } = {}) {
  // Do not poll if a modal is visible
  if (!elements.confirmModal.classList.contains('hidden') || !elements.detailsModal.classList.contains('hidden')) {
    return;
  }

  try {
    const isSystemRes = activeFilter === 'system-resources';
    const url = isSystemRes ? '/api/system/processes' : '/api/ports';
    const data = await resourceClient.getJson(isSystemRes ? 'system-processes' : 'ports', url, { force });
    if (isSystemRes) {
      systemProcessesData = data.processes || [];
    } else {
      portsData = data.ports || [];
      handlePortScanState(data);
    }
    applyFilters();
    markDataFresh();
  } catch (err) {
    if (err?.name === 'AbortError') return;
    console.warn('Silent refresh failed:', err);
    // Preserve the last good snapshot, but never imply that it is current.
    const now = Date.now();
    if (now - lastBackgroundRefreshWarningAt > 30_000) {
      lastBackgroundRefreshWarningAt = now;
      announceUiStatus('הנתונים המוצגים אינם מעודכנים כרגע; החיבור לשרת המקומי נכשל.');
      showToast('הנתונים האחרונים נשמרו, אך הרענון נכשל. נסה לרענן שוב.', 'warning');
    }
  }
}

async function fetchSystemProcesses({ force = true } = {}) {
  renderTableSkeleton('סורק תהליכי מערכת ומשאבים ב-macOS…');
  lastProcessesRenderFingerprint = '';
  elements.emptyState.classList.add('hidden');

  try {
    const data = await resourceClient.getJson('system-processes', '/api/system/processes', { force });
    systemProcessesData = data.processes || [];
    applyFilters();
  } catch (err) {
    if (err?.name === 'AbortError') return;
    console.error(err);
    elements.tableBody.innerHTML = `
      <tr>
        <td colspan="8" class="loading-state" style="color: var(--color-danger)">
          ⚠️ לא מצליח ליצור קשר עם שרת מנהל הפורטים. ודא שהשרת רץ ורענן את הדף.
        </td>
      </tr>
    `;
    showToast('החיבור לשרת אבד. לא ניתן לטעון תהליכי מערכת.', 'error');
  }
}

// --- TABLE HEADERS UPDATER ---
function updateTableHeaders() {
  const headers = document.querySelectorAll('.ports-table th');
  if (headers.length < 8) return;

  if (activeFilter === 'system-resources') {
    headers[0].innerHTML = '-';
    headers[0].classList.remove('sortable');
    headers[3].innerHTML = 'משתמש';
    headers[4].innerHTML = '-';
    headers[5].innerHTML = 'סטטוס';
    headers[5].classList.remove('sortable');
    headers[6].innerHTML = 'משאבים';
    headers[6].classList.remove('sortable');

    // Hide sort indicators for non-sortable columns
    headers.forEach((th, idx) => {
      if (idx !== 1 && idx !== 2 && idx !== 3) {
        const ind = th.querySelector('.sort-indicator');
        if (ind) ind.style.display = 'none';
      }
    });
  } else {
    headers[0].innerHTML = 'פורט <span class="sort-indicator">▲</span>';
    headers[0].classList.add('sortable');
    headers[3].innerHTML = 'כתובת האזנה';
    headers[4].innerHTML = 'פרוטוקול / סוג';
    headers[5].innerHTML = 'גישה';
    headers[6].innerHTML = 'פקודת הפעלה';

    // Restore sort indicators
    headers.forEach(th => {
      const ind = th.querySelector('.sort-indicator');
      if (ind) ind.style.display = '';
    });
  }
}

// --- FILTERING & SORTING ---
function applyFilters() {
  updateTableHeaders();

  if (activeFilter === 'system-resources') {
    filteredProcesses = systemProcessesData.filter(proc => matchSmartQuery(proc, searchQuery, false));
    updateResultsSummary(filteredProcesses.length);

    sortAndRender();
    return;
  }

  filteredPorts = portsData.filter(portObj => {
    // 1. Tab filter
    if (activeFilter === 'system' && !portObj.isSystem) return false;
    if (activeFilter === 'user' && portObj.isSystem) return false;

    // 2. Search query filter
    return matchSmartQuery(portObj, searchQuery, true);
  });

  // Group address-family duplicates, then show identical running commands together.
  filteredPorts = aggregatePorts(deduplicatePorts(filteredPorts));

  updateMetrics();
  updateResultsSummary(filteredPorts.length);
  sortAndRender();
}

function updateResultsSummary(count) {
  const viewLabels = {
    all: 'מה פתוח עכשיו',
    user: 'האפליקציות שלי',
    system: 'שירותי macOS',
    'system-resources': 'כל התהליכים במחשב'
  };
  if (elements.currentViewTitle) {
    elements.currentViewTitle.textContent = viewLabels[activeFilter] || viewLabels.all;
  }
  if (elements.resultsCount) {
    const suffix = activeFilter === 'system-resources' ? 'תהליכים' : 'חיבורים';
    elements.resultsCount.textContent = `${count} ${suffix} מוצגים`;
  }
}

function updateMetrics() {
  // Deduplicate entire ports list for accurate unique counts
  const uniquePorts = deduplicatePorts(portsData);
  const activeCount = uniquePorts.length;
  const userCount = uniquePorts.filter(p => !p.isSystem).length;
  const systemCount = uniquePorts.filter(p => p.isSystem).length;

  if (elements.statusTextConnections) {
    elements.statusTextConnections.textContent = activeCount;
  }

  if (elements.tabBadgePorts) {
    elements.tabBadgePorts.textContent = activeCount;
    if (activeCount > 0) {
      elements.tabBadgePorts.classList.remove('hidden');
    } else {
      elements.tabBadgePorts.classList.add('hidden');
    }
  }

  // Update filter tab labels with inline counts
  elements.filterTabs.forEach(tab => {
    const filter = tab.dataset.filter;
    if (filter === 'all') {
      tab.textContent = `הכול (${activeCount})`;
    } else if (filter === 'user') {
      tab.textContent = `האפליקציות שלי (${userCount})`;
    } else if (filter === 'system') {
      tab.textContent = `macOS (${systemCount})`;
    } else if (filter === 'system-resources') {
      tab.textContent = `כל התהליכים`;
    }
  });

  elements.metricActiveCount.textContent = activeCount;
  elements.metricUserCount.textContent = userCount;
  elements.metricSystemCount.textContent = systemCount;
}

function sortAndRender() {
  if (activeFilter === 'system-resources') {
    const col = currentSort.column;
    const isAsc = currentSort.order === 'asc' ? 1 : -1;

    // Default to 'cpu' if sorting on 'port' which doesn't exist on processes
    let sortCol = col;
    if (col === 'port') sortCol = 'cpu';

    filteredProcesses.sort((a, b) => {
      let valA = a[sortCol];
      let valB = b[sortCol];

      if (typeof valA === 'string') valA = valA.toLowerCase();
      if (typeof valB === 'string') valB = valB.toLowerCase();

      if (valA < valB) return -1 * isAsc;
      if (valA > valB) return 1 * isAsc;
      return 0;
    });

    renderSystemProcessesTable();
    return;
  }

  const col = currentSort.column;
  const isAsc = currentSort.order === 'asc' ? 1 : -1;

  filteredPorts.sort((a, b) => {
    let valA = a[col];
    let valB = b[col];

    if (typeof valA === 'string') valA = valA.toLowerCase();
    if (typeof valB === 'string') valB = valB.toLowerCase();

    if (valA < valB) return -1 * isAsc;
    if (valA > valB) return 1 * isAsc;
    return 0;
  });

  renderTable();
}

function renderSystemProcessesTable() {
  const fingerprint = JSON.stringify(filteredProcesses.map(proc => `${proc.pid}:${proc.cpu}:${proc.memoryMb}:${proc.isSuspended}`)) + `_${currentSort.column}_${currentSort.order}`;
  if (lastProcessesRenderFingerprint === fingerprint) {
    return;
  }
  lastProcessesRenderFingerprint = fingerprint;

  elements.tableBody.innerHTML = '';

  if (filteredProcesses.length === 0) {
    elements.emptyState.classList.remove('hidden');
    return;
  }

  elements.emptyState.classList.add('hidden');

  filteredProcesses.forEach(proc => {
    const tr = document.createElement('tr');
    if (proc.isSuspended) tr.classList.add('row-suspended');

    const pidText = escapeHtml(String(proc.pid ?? ''));
    const isReadOnlyMode = typeof window.SafetySettings !== 'undefined' && !window.SafetySettings.canKill();

    let actionsHtml = '';
    if (proc.isSystem) {
      actionsHtml = `<span class="badge badge-system-lock">מוגן מערכת</span>`;
    } else {
      const killTitle = isReadOnlyMode
        ? 'שרת מנהל הפורטים נמצא במצב "קריאה בלבד". שנה את מצב הבטיחות בהגדרות כדי לאפשר סגירה.'
        : `סגור תהליך PID ${proc.pid} (נדרש אישור)`;

      const pauseResumeBtn = proc.isSuspended
        ? `<button class="action-btn btn-success btn-sm btn-resume-proc" title="המשך פעילות תהליך ${pidText}">המשך</button>`
        : `<button class="action-btn btn-warning btn-sm btn-pause-proc" title="השהה פעילות תהליך ${pidText}">השהיה</button>`;

      actionsHtml = `
        <div class="action-btn-group">
          ${pauseResumeBtn}
          <button class="action-btn btn-danger btn-sm btn-kill-proc" ${isReadOnlyMode ? 'disabled aria-disabled="true"' : ''} title="${escapeHtml(killTitle)}">סגירה</button>
        </div>
      `;
    }

    const processIcon = getProcessIcon(proc.processName);

    tr.innerHTML = `
      <td>-</td>
      <td>
        <div class="process-name-cell">
          <span class="process-icon">${processIcon}</span>
          <span class="process-title" dir="ltr" style="text-align: right; display: inline-block;"><strong>${escapeHtml(proc.processName)}</strong></span>
        </div>
      </td>
      <td class="font-mono column-pid" dir="ltr">${pidText}</td>
      <td class="column-advanced">${escapeHtml(proc.user)}</td>
      <td class="column-advanced">-</td>
      <td>
        ${proc.isSuspended ? '<span class="badge-suspended">מושהה (Suspended)</span>' : 'פעיל (Running)'}
      </td>
      <td class="column-command">${proc.cpu}% CPU / ${proc.memoryMb} MB</td>
      <td class="text-right">
        ${actionsHtml}
      </td>
    `;

    // Hook up buttons
    if (!proc.isSystem) {
      const resumeBtn = tr.querySelector('.btn-resume-proc');
      if (resumeBtn) {
        resumeBtn.addEventListener('click', () => resumeSystemProcess(proc.pid));
      }

      const pauseBtn = tr.querySelector('.btn-pause-proc');
      if (pauseBtn) {
        pauseBtn.addEventListener('click', () => openSuspendConfirmModal(proc));
      }

      const killBtn = tr.querySelector('.btn-kill-proc');
      if (killBtn && !isReadOnlyMode) {
        killBtn.addEventListener('click', () => {
          openConfirmModal('kill', {
            pid: proc.pid,
            processName: proc.processName,
            commandLine: proc.commandLine || proc.processName,
            port: '-'
          });
        });
      }
    }

    elements.tableBody.appendChild(tr);
  });
}

function detectDevStack(portObj) {
  if (!portObj) return null;
  const port = Number(portObj.port || (portObj.ports && portObj.ports[0]));
  const processName = (portObj.processName || portObj.name || '').toLowerCase();
  const cmd = (portObj.commandLine || portObj.cmd || '').toLowerCase();

  if (port === 5173 || port === 5174 || cmd.includes('vite') || processName.includes('vite')) {
    return { name: 'Vite', class: 'stack-vite', icon: '⚡' };
  }
  if (port === 3000 || port === 3001 || cmd.includes('next') || processName.includes('next')) {
    return { name: 'Next.js', class: 'stack-next', icon: '▲' };
  }
  if (port === 8080 || port === 8000 || port === 5000 || cmd.includes('python') || processName.includes('python') || cmd.includes('uvicorn') || cmd.includes('fastapi') || cmd.includes('flask')) {
    return { name: 'Python', class: 'stack-python', icon: '🐍' };
  }
  if (cmd.includes('node') || processName.includes('node') || cmd.includes('express')) {
    return { name: 'Node.js', class: 'stack-node', icon: '🟢' };
  }
  if (port === 5432 || cmd.includes('postgres') || processName.includes('postgres')) {
    return { name: 'Postgres', class: 'stack-postgres', icon: '🐘' };
  }
  if (port === 6379 || cmd.includes('redis') || processName.includes('redis')) {
    return { name: 'Redis', class: 'stack-redis', icon: '🔴' };
  }
  if (port === 27017 || cmd.includes('mongo')) {
    return { name: 'MongoDB', class: 'stack-node', icon: '🍃' };
  }
  if (cmd.includes('docker') || processName.includes('docker')) {
    return { name: 'Docker', class: 'stack-docker', icon: '🐳' };
  }
  return null;
}

// --- RENDERING ---
function renderTable() {
  const tableView = document.getElementById('table-view-wrapper');
  const cardsView = document.getElementById('cards-view-wrapper');
  const simpleSummaryStrip = document.getElementById('simple-summary-strip');

  if (viewMode === 'simple') {
    if (tableView) tableView.classList.add('hidden');
    if (cardsView) cardsView.classList.remove('hidden');
    if (simpleSummaryStrip) simpleSummaryStrip.classList.remove('hidden');

    if (activeFilter === 'system-resources') {
      renderCompactSimpleSystemProcesses();
    } else {
      renderCompactSimplePorts();
    }
    return;
  }

  // Detailed View
  if (tableView) tableView.classList.remove('hidden');
  if (cardsView) cardsView.classList.add('hidden');
  if (simpleSummaryStrip) simpleSummaryStrip.classList.add('hidden');

  if (activeFilter === 'system-resources') {
    return renderSystemProcessesTable();
  }

  const fingerprint = JSON.stringify(filteredPorts.map(p => ({
    port: p.port,
    pid: p.pid || (p.pids ? p.pids.join(',') : ''),
    cpu: p.cpu,
    memoryMb: p.memoryMb,
    address: p.address,
    isSystem: p.isSystem,
    commandLine: p.commandLine,
    user: p.user,
  }))) + `_${viewMode}_${currentSort.column}_${currentSort.order}`;
  if (lastPortsRenderFingerprint === fingerprint) {
    return;
  }
  lastPortsRenderFingerprint = fingerprint;

  elements.tableBody.innerHTML = '';

  if (filteredPorts.length === 0) {
    elements.emptyState.classList.remove('hidden');
    return;
  }

  elements.emptyState.classList.add('hidden');

  filteredPorts.forEach(portObj => {
    const tr = document.createElement('tr');
    const portNumber = Number(portObj.port);
    const portText = escapeHtml((portObj.ports || [portObj.port]).join(', '));
    const pidText = escapeHtml((portObj.pids || [portObj.pid]).join(', '));
    const isSelf = portNumber === selfPort;
    const isSystemProcess = portObj.isSystem === true;
    const isReadOnlyMode = typeof window.SafetySettings !== 'undefined' && !window.SafetySettings.canKill();
    const isAggregate = portObj.isAggregate === true;
    const killDisabled = isAggregate || isSelf || isSystemProcess || isReadOnlyMode;

    // Safety disable reasons in Hebrew
    // Self-protection: this is the Port Manager UI server
    // System-process protection
    // Server is in read-only mode
    // Restart disabled: arbitrary command restart is not available
    const killDisabledReason = isAggregate
      ? 'מוצגים כאן כמה תהליכים זהים. פתח פרטים כדי לראות כל פורט ותהליך בנפרד; סגירה מרוכזת אינה זמינה.'
      : isSelf
        ? 'הגנה עצמית: זהו שרת מנהל הפורטים הנוכחי ולא ניתן לסגור אותו.'
      : isSystemProcess
        ? 'הגנת תהליכי מערכת: תהליך זה מוגדר כחלק ממערכת ההפעלה של macOS ולא ניתן לסגור אותו מטעמי בטיחות.'
        : isReadOnlyMode
          ? 'שרת מנהל הפורטים נמצא במצב "קריאה בלבד". שנה את מצב הבטיחות בהגדרות כדי לאפשר סגירה.'
          : `סגור תהליך PID ${portObj.pid} בפורט ${portObj.port} (נדרש אישור)`;

    // Generate Port Badges HTML individually to prevent RTL wrapping comma bugs
    const portsArray = portObj.ports || [portObj.port];
    const portBadgesHtml = portsArray.map(pNum => {
      const pNumber = Number(pNum);
      const isPNumSelf = pNumber === selfPort;
      let badgeClass = 'port-badge';
      let safetyClass = '';

      if (isPNumSelf) {
        badgeClass += ' self';
        safetyClass = ' self';
      } else if (isSystemProcess) {
        badgeClass += ' system';
        safetyClass = ' system';
      } else if (typeof window.SafetySettings !== 'undefined') {
        const ss = window.SafetySettings.getState();
        if (ss) {
          if (ss.mode === 'allowlist') {
            const isListed = (ss.allowlist || []).includes(pNumber);
            safetyClass = isListed ? ' safe' : ' protected';
          } else if (ss.mode === 'blocklist') {
            const isBlocked = (ss.blocklist || []).includes(pNumber);
            safetyClass = isBlocked ? ' protected' : ' safe';
          }
        }
      }
      if (safetyClass && safetyClass !== ' self' && safetyClass !== ' system') {
        badgeClass += ' ' + safetyClass;
      }

      if (isPNumSelf) {
        return `<span class="${badgeClass}">${pNum}<span class="self-tag">SELF</span></span>`;
      }
      return `<span class="${badgeClass}">${pNum}</span>`;
    }).join('');

    // Command display truncation
    const cmdClean = (portObj.commandLine || '').replace(/\n/g, ' ');
    const processIcon = getProcessIcon(portObj.processName);
    const protocol = escapeHtml(portObj.typeDisplay || `${portObj.protocol} (${portObj.type})`);
    const protocolClass = safeClassName(portObj.protocol || 'unknown');
    const appName = getFriendlyAppName(portObj);
    const sourceInfo = getSourceInfo(portObj);
    const listenerInfo = getListenerInfo(portObj);
    const rawAddresses = portObj.addresses || [portObj.address];
    const addresses = escapeHtml(rawAddresses.join(', '));
    const addressesHtml = rawAddresses.map(address => escapeHtml(address)).join('<br>');
    const processSummary = portObj.instanceCount > 1
      ? `${portObj.instanceCount} תהליכים זהים`
      : rawAddresses.length > 1
        ? `${rawAddresses.length} פורטים מאותו תהליך`
        : '';
    const sourceLabel = [sourceInfo.label, processSummary].filter(Boolean).join(' · ');

    tr.innerHTML = `
      <td>
        <div class="port-badges-wrapper">
          ${portBadgesHtml}
        </div>
      </td>
      <td>
        <div class="process-name-cell">
          <span class="process-icon">${processIcon}</span>
          <div class="process-description">
            <strong class="process-title" dir="ltr">${escapeHtml(appName)}</strong>
            <span class="source-label">${escapeHtml(sourceLabel)}</span>
            <code class="source-path" dir="ltr" title="${escapeHtml(sourceInfo.path)}">${escapeHtml(sourceInfo.path)}</code>
          </div>
        </div>
      </td>
      <td class="font-mono column-pid" dir="ltr">${pidText}</td>
      <td class="column-advanced font-mono" dir="ltr">${addresses}</td>
      <td class="column-advanced">
        <span class="protocol-badge ${protocolClass}">${protocol}</span>
      </td>
      <td>
        <div class="listener-summary">
          <strong>${escapeHtml(listenerInfo.label)}</strong>
          <span class="font-mono" dir="ltr">${addressesHtml}</span>
        </div>
      </td>
      <td class="command-cell column-command" title="${escapeHtml(cmdClean)}" dir="ltr" style="text-align: left;">
        ${escapeHtml(cmdClean)}
      </td>
      <td class="text-right">
        <div class="action-group">
          <button class="action-btn btn-details-action" title="הצג פרטים מלאים ופקודת הפעלה" aria-label="הצג פרטים מלאים עבור תהליך ${pidText} בפורט ${portText}">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <circle cx="12" cy="12" r="10"></circle>
              <line x1="12" y1="16" x2="12" y2="12"></line>
              <line x1="12" y1="8" x2="12.01" y2="8"></line>
            </svg>
            <span>פרטים</span>
          </button>
          <button class="action-btn btn-kill-action" ${killDisabled ? 'disabled aria-disabled="true"' : ''} title="${escapeHtml(killDisabledReason)}" aria-label="${escapeHtml(killDisabledReason)}">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M18.36 6.64a9 9 0 1 1-12.73 0"></path>
              <line x1="12" y1="2" x2="12" y2="12"></line>
            </svg>
            <span>${killDisabled ? 'מוגן' : 'סגירה'}</span>
          </button>
        </div>
      </td>
    `;

    // Hook buttons up
    tr.querySelector('.btn-details-action').addEventListener('click', () => {
      openDetailsModal(portObj);
    });

    if (!killDisabled) {
      tr.querySelector('.btn-kill-action').addEventListener('click', () => {
        openConfirmModal('kill', portObj);
      });
    }

    elements.tableBody.appendChild(tr);
  });
}

// --- ACTIONS & MODALS ---
function openConfirmModal(action, portObj) {
  stopPolling();

  // Show standard process preview and warning
  const modalWarning = document.getElementById('modal-warning');
  const previewBox = document.querySelector('.process-preview-box');
  if (modalWarning) {
    modalWarning.style.display = 'block';
    modalWarning.innerHTML = '⚠️ <strong>אזהרה:</strong> סגירת תוכנה השייכת לפורט פעיל שולחת אות סיום (SIGTERM) שעלולה לגרום לאובדן נתונים שלא נשמרו.';
  }
  if (previewBox) previewBox.style.display = 'block';

  // Clean elements
  elements.previewPort.textContent = portObj.port !== undefined ? portObj.port : '-';
  elements.previewProcess.textContent = portObj.processName;
  elements.previewPid.textContent = portObj.pid;
  elements.previewCommand.textContent = portObj.commandLine;

  // Prepare confirmation gate
  resetDestructiveConfirmation();
  const risk = assessProcessRisk(portObj);
  destructiveActionContext = { action, pid: String(portObj.pid), riskLevel: risk.level };
  elements.confirmRequiredPid.textContent = String(portObj.pid);

  if (action === 'kill') {
    // Populate Risk Banner
    const riskBanner = document.getElementById('modal-risk-banner');
    const riskBadge = document.getElementById('modal-risk-badge');
    const riskExplanation = document.getElementById('modal-risk-explanation');
    if (riskBanner && riskBadge && riskExplanation) {
      riskBanner.style.display = 'block';
      riskBadge.textContent = risk.label;
      riskBadge.className = 'risk-badge ' + risk.badgeClass;
      riskExplanation.textContent = risk.explanation;
    }

    elements.modalTitle.textContent = 'אישור סגירת תוכנה ותהליך';
    const portDesc = portObj.port && portObj.port !== '-' ? ` בפורט <strong>${portObj.port}</strong>` : '';
    elements.modalDesc.innerHTML = `פעולה זו תשלח אות כיבוי (<code>SIGTERM</code>) למזהה תהליך (PID) <strong>${portObj.pid}</strong>${portDesc}. סגור את התוכנה רק אם אתה בטוח שהיא אינה חיונית לפעילותך.`;
    elements.modalConfirmBtn.textContent = 'סגור תוכנה (Terminate)';
    elements.modalConfirmBtn.className = 'btn btn-danger';

    const confirmHelp = document.getElementById('confirm-help');
    if (risk.level === 'low') {
      if (confirmHelp) confirmHelp.style.display = 'none';
      elements.modalConfirmBtn.disabled = false;
    } else {
      if (confirmHelp) confirmHelp.style.display = 'block';
      elements.modalConfirmBtn.disabled = true;
    }

    // Set confirmation button callback
    elements.modalConfirmBtn.onclick = async () => {
      if (!validateDestructiveConfirmation(portObj)) return;
      elements.modalConfirmBtn.disabled = true;
      elements.modalConfirmBtn.textContent = 'סוגר תהליך...';

      const success = await executeKill(portObj.pid, portObj.port);
      elements.confirmModal.classList.add('hidden');
      resetDestructiveConfirmation();

      if (success) {
        if (activeFilter === 'system-resources') {
          fetchSystemProcesses();
        } else {
          fetchPorts();
        }
      } else {
        startPolling();
      }
    };
  } else if (action === 'restart') {
    elements.modalTitle.textContent = 'אתחול אינו זמין';
    elements.modalDesc.textContent = `אתחול תוכנה מנוטרל עבור פורט ${portObj.port}. הרצת פקודות הפעלה אינה נתמכת כרגע.`;
    elements.modalConfirmBtn.textContent = 'אתחול כבוי';
    elements.modalConfirmBtn.className = 'btn btn-secondary';
    elements.modalConfirmBtn.disabled = true;
    elements.modalConfirmBtn.onclick = null;
  }

  elements.confirmModal.classList.remove('hidden');
  elements.confirmPidInput.focus();
}

function resetDestructiveConfirmation() {
  destructiveActionContext = null;
  elements.confirmPidInput.value = '';
  elements.confirmUnderstandCheckbox.checked = false;
  elements.confirmRequiredPid.textContent = '--';
  elements.modalConfirmBtn.disabled = true;
  elements.modalConfirmBtn.onclick = null;
  const confirmHelp = document.getElementById('confirm-help');
  if (confirmHelp) confirmHelp.style.display = 'block';

  const riskBanner = document.getElementById('modal-risk-banner');
  if (riskBanner) riskBanner.style.display = 'none';
}

function openSuspendConfirmModal(process) {
  stopPolling();
  resetDestructiveConfirmation();

  const modalWarning = document.getElementById('modal-warning');
  const previewBox = document.querySelector('.process-preview-box');
  const confirmHelp = document.getElementById('confirm-help');
  if (modalWarning) {
    modalWarning.style.display = 'block';
    modalWarning.innerHTML = '⚠️ <strong>אזהרה:</strong> השבתת התהליך עשויה להפסיק עבודה שטרם נשמרה. ניתן להמשיך את הפעילות אחר כך.';
  }
  if (previewBox) previewBox.style.display = 'block';
  if (confirmHelp) confirmHelp.style.display = 'none';

  elements.previewPort.textContent = '-';
  elements.previewProcess.textContent = process.processName;
  elements.previewPid.textContent = process.pid;
  elements.previewCommand.textContent = process.commandLine || process.processName;
  destructiveActionContext = { action: 'suspend', pid: String(process.pid) };
  elements.modalTitle.textContent = 'אישור השהיית תהליך';
  elements.modalDesc.textContent = `האם להשהות את ${process.processName} (PID ${process.pid})?`;
  elements.modalConfirmBtn.textContent = 'השהה תהליך';
  elements.modalConfirmBtn.className = 'btn btn-danger';
  elements.modalConfirmBtn.disabled = false;
  elements.modalConfirmBtn.onclick = async () => {
    elements.modalConfirmBtn.disabled = true;
    elements.modalConfirmBtn.textContent = 'משהה תהליך...';
    const success = await suspendSystemProcess(process.pid);
    if (success) {
      elements.confirmModal.classList.add('hidden');
      resetDestructiveConfirmation();
    } else {
      elements.modalConfirmBtn.disabled = false;
      elements.modalConfirmBtn.textContent = 'השהה תהליך';
    }
  };

  elements.confirmModal.classList.remove('hidden');
}

function validateDestructiveConfirmation(portObj = null) {
  const activeAction = portObj && typeof portObj.pid !== 'undefined'
    ? 'kill'
    : destructiveActionContext?.action;
  const requiredPid = portObj && typeof portObj.pid !== 'undefined'
    ? String(portObj.pid)
    : destructiveActionContext?.pid || elements.confirmRequiredPid.textContent;

  const riskLevel = portObj ? assessProcessRisk(portObj).level : destructiveActionContext?.riskLevel;
  if (riskLevel === 'low') {
    elements.modalConfirmBtn.disabled = false;
    return true;
  }

  const typedPidMatches = elements.confirmPidInput.value.trim() === requiredPid && requiredPid !== '--';
  const checkboxChecked = elements.confirmUnderstandCheckbox.checked;
  const isValid = activeAction === 'kill' && typedPidMatches && checkboxChecked;
  elements.modalConfirmBtn.disabled = !isValid;
  return isValid;
}

function openDetailsModal(portObj) {
  stopPolling();

  elements.specPort.textContent = (portObj.ports || [portObj.port]).join(', ');
  elements.specName.textContent = getFriendlyAppName(portObj);
  elements.specPid.textContent = (portObj.pids || [portObj.pid]).join(', ');
  elements.specUser.textContent = portObj.user;
  elements.specAddress.textContent = (portObj.addresses || [portObj.address]).join(', ');
  elements.specSource.textContent = getSourceInfo(portObj).path;
  elements.specProtocol.textContent = portObj.protocol;
  elements.specType.textContent = portObj.typeDisplay || portObj.type;
  elements.specCpu.textContent = `${Number(portObj.cpu || 0).toFixed(1)}%`;
  elements.specMemory.textContent = `${Number(portObj.memoryMb || 0).toFixed(1)} MB`;
  elements.specCommand.textContent = portObj.commandLine;

  elements.btnCopyCommand.onclick = () => {
    navigator.clipboard.writeText(portObj.commandLine)
      .then(() => {
        const originalText = elements.btnCopyCommand.innerHTML;
        elements.btnCopyCommand.innerHTML = 'הועתק!';
        elements.btnCopyCommand.style.background = 'var(--color-success-bg)';
        elements.btnCopyCommand.style.color = 'var(--color-success)';
        setTimeout(() => {
          elements.btnCopyCommand.innerHTML = originalText;
          elements.btnCopyCommand.style.background = '';
          elements.btnCopyCommand.style.color = '';
        }, 1500);
      })
      .catch(err => {
        console.error('Copy failed:', err);
        showToast('העתקת הפקודה ללוח נכשלה', 'error');
      });
  };

  elements.detailsModal.classList.remove('hidden');
}

// --- CALL TO BACKEND APIs ---
async function executeKill(pid, port) {
  try {
    const isSystemKill = port === undefined || port === null || port === '-' || activeFilter === 'system-resources';
    const url = isSystemKill ? '/api/system/kill' : '/api/ports/kill';
    const body = isSystemKill ? { pid, confirm: true } : { pid, port, confirm: true };

    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });

    const data = await res.json();
    if (!res.ok) throw new Error(data.error?.message || data.error || 'שגיאה בסגירת התהליך בשרת');

    const msg = isSystemKill ? `תהליך ${pid} נסגר בהצלחה!` : `תהליך ${pid} בפורט ${port} נסגר בהצלחה!`;
    showToast(msg, 'success');
    logRecentAction('kill', isSystemKill ? `PID ${pid}` : `פורט ${port}`, isSystemKill ? `מזהה תהליך: ${pid}` : `מזהה תהליך: ${pid}`);
    return true;
  } catch (err) {
    showToast(err.message, 'error');
    return false;
  }
}

function updateProgressRing(circleElement, percentage) {
  if (!circleElement) return;
  const radius = circleElement.r.baseVal.value;
  const circumference = 2 * Math.PI * radius;
  circleElement.style.strokeDasharray = `${circumference} ${circumference}`;
  const offset = circumference - (Math.min(100, Math.max(0, percentage)) / 100) * circumference;
  circleElement.style.strokeDashoffset = offset;

  // Update progress color based on usage using CSS variables for theme consistency
  if (percentage > 80) {
    circleElement.style.stroke = 'var(--color-danger)';
  } else if (percentage > 50) {
    circleElement.style.stroke = 'var(--color-warning)';
  } else {
    circleElement.style.stroke = 'var(--color-primary)';
  }
}

async function updateSystemUsage({ force = false } = {}) {
  const diskUpdate = updateDiskUsage({ force });
  try {
    const data = await resourceClient.getJson('system-usage', '/api/system/usage', { force });

    // Update metric display
    if (elements.statusTextCpu) {
      elements.statusTextCpu.textContent = `${data.cpu.toFixed(1)}%`;
    }
    updateProgressRing(elements.statusRingCpu, data.cpu);

    if (elements.statusTextMemory) {
      const usedGb = (data.memory.usedBytes / (1024 ** 3)).toFixed(1);
      const totalGb = (data.memory.totalBytes / (1024 ** 3)).toFixed(0);
      elements.statusTextMemory.textContent = `${usedGb}/${totalGb} GB`;
    }
    updateProgressRing(elements.statusRingMemory, data.memory.percentage);

    // Keep compatibility for any other modules
    if (elements.metricCpuUsage) {
      elements.metricCpuUsage.textContent = `${data.cpu}%`;
    }
    if (elements.metricMemoryUsage) {
      const usedGb = (data.memory.usedBytes / (1024 ** 3)).toFixed(2);
      const totalGb = (data.memory.totalBytes / (1024 ** 3)).toFixed(2);
      elements.metricMemoryUsage.textContent = `${usedGb} מתוך ${totalGb} GB`;
    }

    // Check if banner should be displayed
    if (data.cpu > 70 || data.memory.percentage > 80) {
      await renderWarningBanner(data);
    } else {
      if (elements.warningBanner) {
        elements.warningBanner.classList.add('hidden');
      }
    }
  } catch (err) {
    if (err?.name === 'AbortError') return;
    console.error('Failed to update system metrics:', err);
  } finally {
    // A manual refresh should not report completion while the paired disk
    // measurement is still in flight.
    await diskUpdate;
  }
}

function renderDiskUsage(disk) {
  if (elements.statusTextDisk) {
    elements.statusTextDisk.textContent = `${disk.percentage}% בשימוש`;
  }
  if (elements.metricDiskUsage) {
    elements.metricDiskUsage.textContent = `${disk.percentage}% בשימוש`;
  }
  if (elements.metricDiskDetail) {
    elements.metricDiskDetail.textContent = `${formatBytes(disk.availableBytes)} פנויים מתוך ${formatBytes(disk.totalBytes)}`;
  }
}

async function updateDiskUsage({ force = false } = {}) {
  try {
    renderDiskUsage(await resourceClient.getJson('disk', '/api/system/disk', { force }));
  } catch (err) {
    if (err?.name === 'AbortError') return;
    console.warn('Failed to update disk metric:', err);
  }
}

function formatCacheBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return '-';
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(i < 2 ? 0 : 1)) + ' ' + sizes[i];
}

async function executeTrashCache(path) {
  try {
    const res = await fetch('/api/system/cache/trash', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path, confirm: true })
    });

    const data = await res.json();
    if (!res.ok) {
      const errMsg = data.error?.message || data.error || 'שגיאה במחיקת התיקייה';
      throw new Error(errMsg);
    }

    showToast(`תיקיית ה-Cache בנתיב ${path} הועברה לפח האשפה בהצלחה!`, 'success');
    logRecentAction('trash-cache', path.split('/').pop() || path, `נתיב: ${path}`);
    return true;
  } catch (err) {
    showToast(err.message, 'error');
    return false;
  }
}

async function executeTrashCachesBatch(paths) {
  try {
    const res = await fetch('/api/system/cache/trash', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ paths, confirm: true })
    });

    const data = await res.json();
    if (!res.ok) {
      const errMsg = data.error?.message || data.error || 'שגיאה בניקוי התיקיות';
      throw new Error(errMsg);
    }

    showToast(`הועברו בהצלחה ${paths.length} תיקיות לפח האשפה!`, 'success');
    logRecentAction('clean-cache', `${paths.length} תיקיות`, `ניקוי מרוכז של תיקיות Cache`);
    return true;
  } catch (err) {
    showToast(err.message, 'error');
    return false;
  }
}

function openSafeCleanWizard() {
  if (!getSafeCacheItems(cacheItemsData).length) return;
  safeCleanWizardReturnFocus = document.activeElement;
  safeCleanWizardStep = 1;
  renderSafeCleanWizardStep();
  elements.safeCleanWizard.classList.remove('hidden');
  elements.safeCleanWizardClose.focus();
}

function closeSafeCleanWizard() {
  if (!elements.safeCleanWizard || elements.safeCleanWizard.classList.contains('hidden')) return;
  elements.safeCleanWizard.classList.add('hidden');
  safeCleanWizardReturnFocus?.focus();
}

function renderSafeCleanWizardStep() {
  const safeItems = getSafeCacheItems(cacheItemsData);
  const totalBytes = safeItems.reduce((sum, item) => sum + (item.bytes || 0), 0);
  const stepContent = {
    1: { description: '<p>ננקה רק קבצים שהמערכת סימנה מראש כבטוחים. אפליקציות עשויות ליצור אותם מחדש בפעם הבאה שיפעלו.</p>', next: 'לרשימת הפריטים' },
    2: { description: `<p>אלה ${safeItems.length} הפריטים שייכללו בניקוי הבטוח, בהיקף כולל של <strong>${formatCacheBytes(totalBytes)}</strong>.</p>`, next: 'להמשך לאישור' },
    3: { description: '<p><strong>הפריטים יועברו לפח האשפה ולא יימחקו לצמיתות.</strong> אפשר לשחזר אותם מהפח אם צריך.</p>', next: 'העבר לפח האשפה' }
  }[safeCleanWizardStep];
  elements.safeCleanWizardProgress.textContent = `שלב ${safeCleanWizardStep} מתוך 3`;
  elements.safeCleanWizardDescription.innerHTML = stepContent.description;
  elements.safeCleanWizardItems.replaceChildren();
  if (safeCleanWizardStep >= 2) {
    safeItems.forEach(item => {
      const row = document.createElement('div');
      row.className = 'safe-clean-wizard-item';
      row.innerHTML = `<span>${escapeHtml(item.name)}</span><strong>${formatCacheBytes(item.bytes)}</strong>`;
      elements.safeCleanWizardItems.appendChild(row);
    });
  }
  elements.safeCleanWizardBack.classList.toggle('hidden', safeCleanWizardStep === 1);
  elements.safeCleanWizardNext.textContent = stepContent.next;
  elements.safeCleanWizardNext.className = safeCleanWizardStep === 3 ? 'btn btn-danger' : 'btn btn-primary';
}

async function confirmSafeCleanWizard() {
  const paths = getSafeCacheItems(cacheItemsData).map(item => item.path);
  if (!paths.length) return;
  elements.safeCleanWizardNext.disabled = true;
  const success = await executeTrashCachesBatch(paths);
  elements.safeCleanWizardNext.disabled = false;
  if (success) {
    closeSafeCleanWizard();
    await updateStorageUsage({ force: true });
  }
}

function openCacheConfirmModal(cacheItem) {
  stopPolling();

  // Hide process preview and process termination warnings
  const modalWarning = document.getElementById('modal-warning');
  const previewBox = document.querySelector('.process-preview-box');
  if (modalWarning) modalWarning.style.display = 'none';
  if (previewBox) previewBox.style.display = 'none';

  // Clean / prepare elements
  elements.previewPort.textContent = '-';
  elements.previewProcess.textContent = cacheItem.name;
  elements.previewPid.textContent = '-';
  elements.previewCommand.textContent = cacheItem.path;

  // Set context
  destructiveActionContext = { action: 'trash-cache', path: cacheItem.path };

  // Hide confirm gate
  const confirmHelp = document.getElementById('confirm-help');
  if (confirmHelp) confirmHelp.style.display = 'none';

  // Customize title, description & button
  elements.modalTitle.textContent = 'אישור העברה לפח האשפה';
  elements.modalDesc.innerHTML = `האם אתה בטוח שברצונך להעביר את תיקיית ה-Cache <strong>${escapeHtml(cacheItem.name)}</strong> בנתיב <code>${escapeHtml(cacheItem.path)}</code> לפח האשפה?`;
  elements.modalConfirmBtn.textContent = 'העבר לאשפה (Trash)';
  elements.modalConfirmBtn.className = 'btn btn-danger';
  elements.modalConfirmBtn.disabled = false; // Enabled immediately for cache trashing!

  elements.modalConfirmBtn.onclick = async () => {
    elements.modalConfirmBtn.disabled = true;
    elements.modalConfirmBtn.textContent = 'מעביר לפח האשפה...';

    const success = await executeTrashCache(cacheItem.path);
    elements.confirmModal.classList.add('hidden');

    // Restore confirm-help display style
    if (confirmHelp) confirmHelp.style.display = 'block';
    resetDestructiveConfirmation();

    if (success) {
      updateStorageUsage({ force: true });
    } else {
      startPolling();
    }
  };

  elements.confirmModal.classList.remove('hidden');
}

async function updateStorageUsage({ force = false } = {}) {
  const cachedUsage = force ? null : persistentCache.read(STORAGE_CACHE_KEY, STORAGE_CACHE_TTL_MS);
  if (cachedUsage) {
    renderStorageUsage(cachedUsage);
    return;
  }

  const staleUsage = force ? null : persistentCache.read(STORAGE_CACHE_KEY, Infinity);
  if (staleUsage) renderStorageUsage(staleUsage);

  elements.storageRefreshBtn.disabled = true;

  // Show skeleton loader
  if (!document.getElementById('skeleton-styles')) {
    const style = document.createElement('style');
    style.id = 'skeleton-styles';
    style.textContent = `
      @keyframes skeleton-pulse {
        0% { opacity: 0.35; }
        50% { opacity: 0.75; }
        100% { opacity: 0.35; }
      }
      .skeleton-row {
        animation: skeleton-pulse 1.5s infinite ease-in-out;
      }
    `;
    document.head.appendChild(style);
  }

  elements.cacheFindings.innerHTML = `
    <div class="cache-item-row skeleton-row" style="pointer-events: none; border-color: rgba(255, 255, 255, 0.05); display: flex; justify-content: space-between; align-items: center; background: rgba(255, 255, 255, 0.02); padding: 12px 16px; border-radius: var(--radius-md); margin-bottom: 8px;">
      <div style="flex-grow: 1;">
        <div style="background: rgba(255, 255, 255, 0.08); height: 16px; width: 120px; border-radius: 4px; margin-bottom: 8px;"></div>
        <div style="background: rgba(255, 255, 255, 0.04); height: 12px; width: 220px; border-radius: 4px; margin-bottom: 6px;"></div>
        <div style="background: rgba(255, 255, 255, 0.02); height: 10px; width: 160px; border-radius: 4px;"></div>
      </div>
      <div style="display: flex; align-items: center; gap: 12px;">
        <div style="background: rgba(255, 255, 255, 0.08); height: 14px; width: 50px; border-radius: 4px;"></div>
        <div style="background: rgba(255, 255, 255, 0.04); height: 32px; width: 32px; border-radius: 4px;"></div>
      </div>
    </div>
    <div class="cache-item-row skeleton-row" style="pointer-events: none; border-color: rgba(255, 255, 255, 0.05); display: flex; justify-content: space-between; align-items: center; background: rgba(255, 255, 255, 0.02); padding: 12px 16px; border-radius: var(--radius-md); margin-bottom: 8px;">
      <div style="flex-grow: 1;">
        <div style="background: rgba(255, 255, 255, 0.08); height: 16px; width: 90px; border-radius: 4px; margin-bottom: 8px;"></div>
        <div style="background: rgba(255, 255, 255, 0.04); height: 12px; width: 180px; border-radius: 4px; margin-bottom: 6px;"></div>
        <div style="background: rgba(255, 255, 255, 0.02); height: 10px; width: 130px; border-radius: 4px;"></div>
      </div>
      <div style="display: flex; align-items: center; gap: 12px;">
        <div style="background: rgba(255, 255, 255, 0.08); height: 14px; width: 45px; border-radius: 4px;"></div>
        <div style="background: rgba(255, 255, 255, 0.04); height: 32px; width: 32px; border-radius: 4px;"></div>
      </div>
    </div>
  `;

  try {
    const [disk, { items }] = await Promise.all([
      resourceClient.getJson('disk', '/api/system/disk', { force }),
      resourceClient.getJson('cache', '/api/system/cache', { force }),
    ]);
    const usage = { disk, items };
    persistentCache.write(STORAGE_CACHE_KEY, usage);
    renderStorageUsage(usage);
    renderDiskUsage(disk);
  } catch (err) {
    if (err?.name === 'AbortError') return;
    console.warn('Failed to update storage/cache metrics:', err);
    if (!staleUsage) elements.cacheFindings.textContent = 'לא ניתן לסרוק Cache כרגע.';
  } finally {
    elements.storageRefreshBtn.disabled = false;
  }
}

function renderStorageUsage({ disk, items: cacheItems }) {
  renderDiskUsage(disk);
  cacheItemsData = cacheItems;

  const totalBytes = cacheItems.reduce((acc, item) => acc + (item.bytes || 0), 0);
  const scannedItems = cacheItems.length;

  // Update new elements
  if (elements.tabBadgeCache) {
    const sizeText = formatCacheBytes(totalBytes);
    elements.tabBadgeCache.textContent = sizeText;
    if (totalBytes > 0) {
      elements.tabBadgeCache.classList.remove('hidden');
    } else {
      elements.tabBadgeCache.classList.add('hidden');
    }
  }

  if (elements.metricCacheUsage) {
    elements.metricCacheUsage.textContent = formatCacheBytes(totalBytes);
  }
  if (elements.metricCacheDetail) {
    elements.metricCacheDetail.textContent = `${scannedItems} תיקיות Cache קריאות, ללא מחיקה אוטומטית`;
  }

  filterAndRenderCache();
}

function getSafeCacheItems(items) {
  return (items || []).filter(item => item.category === 'SAFE_TO_CLEAR');
}

function getCacheCategoryCopy(category) {
  return {
    SAFE_TO_CLEAR: { title: 'מומלץ לניקוי', hint: 'קבצים זמניים שאפשר ליצור מחדש', safety: 'נכלל בניקוי הבטוח' },
    NEEDS_CONFIRMATION: { title: 'כדאי לבדוק לפני ניקוי', hint: 'ייתכן שאפליקציה תצטרך ליצור אותם מחדש', safety: 'לא נכלל בניקוי הבטוח' },
    SYSTEM_PROTECTED: { title: 'מוגן ולא ניתן לניקוי', hint: 'המערכת מגינה על פריטים אלה', safety: 'הפריט מוגן ולא ניתן לניקוי' }
  }[category];
}

function createCacheItemCard(item) {
  const isProtected = item.category === 'SYSTEM_PROTECTED';
  const copy = getCacheCategoryCopy(item.category);
  const card = document.createElement('article');
  card.className = 'cache-item-card';
  card.innerHTML = `
    <div>
      <h4>${escapeHtml(item.name)}</h4>
      <p>${escapeHtml(item.description || copy.hint)}</p>
      <p class="cache-item-safety">${copy.safety}</p>
      <details class="cache-item-details"><summary>פרטים טכניים</summary><code>${escapeHtml(item.path)}</code></details>
    </div>
    <div>
      <strong>${formatCacheBytes(item.bytes)}</strong>
      ${isProtected
        ? '<span class="cache-item-safety">מידע בלבד</span>'
        : '<button class="btn btn-danger cache-item-action" type="button">העבר לפח</button>'}
    </div>`;
  if (!isProtected) {
    card.querySelector('button').addEventListener('click', () => openCacheConfirmModal(item));
  }
  return card;
}

const protectedCacheGroups = [
  { id: 'apple-user', title: 'מטמוני Apple בחשבון המשתמש', hint: 'פריטי מטמון של Apple בחשבון המשתמש — מידע בלבד.' },
  { id: 'shared-system', title: 'מטמוני מערכת משותפים', hint: 'מנוהל על ידי macOS ואינו זמין לניקוי.' },
  { id: 'macos-system', title: 'מטמוני macOS מוגנים', hint: 'מנוהל על ידי macOS ואינו זמין לניקוי.' }
];

function renderProtectedCacheSubgroup(groupInfo, items) {
  const subgroup = document.createElement('section');
  subgroup.className = 'cache-protected-subgroup';
  subgroup.innerHTML = `<h4>${escapeHtml(groupInfo.title)}</h4><p>${escapeHtml(groupInfo.hint)}</p>`;
  items.forEach(item => subgroup.appendChild(createCacheItemCard(item)));
  return subgroup;
}

function renderCacheGroup(category, items) {
  const copy = getCacheCategoryCopy(category);
  const totalBytes = items.reduce((sum, item) => sum + (item.bytes || 0), 0);
  const panelId = `cache-group-${category.toLowerCase()}`;
  const group = document.createElement('section');
  group.className = 'cache-group glass';
  group.dataset.cacheCategory = category;
  group.innerHTML = `
    <button class="cache-group-trigger" type="button" aria-expanded="false" aria-controls="${panelId}">
      <span><strong>${copy.title}</strong><small>${copy.hint}</small></span>
      <span class="cache-group-trigger-meta">${items.length} פריטים · ${formatCacheBytes(totalBytes)} <span class="cache-group-chevron" aria-hidden="true">⌄</span></span>
    </button>
    <div id="${panelId}" class="cache-group-panel" hidden></div>`;
  const trigger = group.querySelector('.cache-group-trigger');
  const panel = group.querySelector('.cache-group-panel');
  trigger.addEventListener('click', () => {
    const expanded = trigger.getAttribute('aria-expanded') === 'true';
    trigger.setAttribute('aria-expanded', String(!expanded));
    panel.hidden = expanded;
  });
  if (category === 'SYSTEM_PROTECTED') {
    protectedCacheGroups.forEach(groupInfo => {
      const groupItems = items.filter(item => item.protectedGroup === groupInfo.id);
      if (groupItems.length) panel.appendChild(renderProtectedCacheSubgroup(groupInfo, groupItems));
    });
    const ungroupedItems = items.filter(item => !protectedCacheGroups.some(groupInfo => groupInfo.id === item.protectedGroup));
    if (ungroupedItems.length) {
      panel.appendChild(renderProtectedCacheSubgroup({
        title: 'מטמונים מוגנים נוספים',
        hint: 'מנוהל על ידי macOS ואינו זמין לניקוי.'
      }, ungroupedItems));
    }
  } else {
    items.forEach(item => panel.appendChild(createCacheItemCard(item)));
  }
  return group;
}

function filterAndRenderCache() {
  let items = cacheItemsData || [];

  // 1. Search Query filter
  if (cacheSearchQuery) {
    items = items.filter(item =>
      item.name.toLowerCase().includes(cacheSearchQuery) ||
      item.path.toLowerCase().includes(cacheSearchQuery)
    );
  }

  // 2. Safety category filter
  if (activeCacheFilter !== 'all') {
    items = items.filter(item => item.category === activeCacheFilter);
  }

  // 3. Size filter
  if (cacheSizeFilterVal === '100mb') {
    items = items.filter(item => (item.bytes || 0) >= 100 * 1024 * 1024);
  } else if (cacheSizeFilterVal === '1gb') {
    items = items.filter(item => (item.bytes || 0) >= 1024 * 1024 * 1024);
  }

  // Update Cache results count
  if (elements.cacheResultsCount) {
    const totalFilteredBytes = items.reduce((acc, item) => acc + (item.bytes || 0), 0);
    elements.cacheResultsCount.textContent = `נמצאו ${items.length} תיקיות (${formatCacheBytes(totalFilteredBytes)})`;
  }

  elements.cacheGroups.replaceChildren();

  if (items.length === 0) {
    if (elements.cacheEmptyState) elements.cacheEmptyState.classList.remove('hidden');
    const quickCleanBtn = document.getElementById('quick-clean-cache-btn');
    if (quickCleanBtn) quickCleanBtn.classList.add('hidden');
    return;
  }

  if (elements.cacheEmptyState) elements.cacheEmptyState.classList.add('hidden');

  // Quick Clean button visibility
  const hasSafeToClear = items.some(item => item.category === 'SAFE_TO_CLEAR');
  const quickCleanBtn = document.getElementById('quick-clean-cache-btn');
  if (quickCleanBtn) {
    if (hasSafeToClear) {
      quickCleanBtn.classList.remove('hidden');
    } else {
      quickCleanBtn.classList.add('hidden');
    }
  }

  const safeItems = getSafeCacheItems(cacheItemsData);
  const scannedBytes = cacheItemsData.reduce((sum, item) => sum + (item.bytes || 0), 0);
  const safeBytes = safeItems.reduce((sum, item) => sum + (item.bytes || 0), 0);
  if (elements.cacheSummarySafeSize) elements.cacheSummarySafeSize.textContent = formatCacheBytes(safeBytes);
  if (elements.cacheSummaryTotalSize) elements.cacheSummaryTotalSize.textContent = `${cacheItemsData.length} פריטים · ${formatCacheBytes(scannedBytes)}`;
  ['SAFE_TO_CLEAR', 'NEEDS_CONFIRMATION', 'SYSTEM_PROTECTED'].forEach(category => {
    elements.cacheGroups.appendChild(renderCacheGroup(category, items.filter(item => item.category === category)));
  });
}

async function renderWarningBanner(usage) {
  // If a modal is open, skip updating the banner to prevent user interruption
  if (!elements.confirmModal.classList.contains('hidden') || !elements.detailsModal.classList.contains('hidden')) {
    return;
  }

  try {
    const res = await fetch('/api/system/processes');
    if (!res.ok) return;
    const { processes } = await res.json();

    // Find top 1-2 non-system user processes
    const heavyProcs = processes
      .filter(p => !p.isSystem && !p.isSuspended)
      .slice(0, 2);

    if (heavyProcs.length === 0) {
      if (elements.warningBanner) {
        elements.warningBanner.classList.add('hidden');
      }
      return;
    }

    if (elements.warningBanner) {
      elements.warningBanner.classList.remove('hidden');
    }

    if (elements.warningMessage) {
      const overloaded = [];
      if (usage.cpu > 70) overloaded.push(`CPU ${usage.cpu}%`);
      if (usage.memory.percentage > 80) overloaded.push(`זיכרון ${usage.memory.percentage}%`);
      elements.warningMessage.textContent = `עומס גבוה: ${overloaded.join(' · ')}. בדוק את התהליכים הבאים לפני סגירה או השהיה.`;
    }

    if (elements.warningSuggestions) {
      elements.warningSuggestions.innerHTML = '';
      heavyProcs.forEach(proc => {
        const card = document.createElement('div');
        card.className = 'suggestion-card';

        card.innerHTML = `
          <div class="suggestion-info">
            <h4 style="margin: 0; font-size: 0.95rem;">${escapeHtml(proc.processName)} (PID: ${proc.pid})</h4>
            <p style="margin: 4px 0 0 0; font-size: 0.8rem; color: #aaa;">${proc.cpu}% CPU / ${proc.memoryMb} MB</p>
          </div>
          <div class="action-btn-group">
            <button class="btn btn-sm btn-warning btn-pause-suggest" data-pid="${proc.pid}">⏸️ השהה</button>
            <button class="btn btn-sm btn-danger btn-kill-suggest" data-pid="${proc.pid}">❌ סגור</button>
          </div>
        `;

        // Hook up buttons
        card.querySelector('.btn-pause-suggest').addEventListener('click', () => {
          openSuspendConfirmModal(proc);
        });
        card.querySelector('.btn-kill-suggest').addEventListener('click', () => {
          openConfirmModal('kill', {
            pid: proc.pid,
            processName: proc.processName,
            commandLine: proc.commandLine || proc.processName,
            port: '-'
          });
        });

        elements.warningSuggestions.appendChild(card);
      });
    }

    if (elements.quickCleanBtn) {
      // Bulk termination cannot meet the per-process safety confirmation policy.
      // Keep recommendations actionable through the individual, inspected rows.
      elements.quickCleanBtn.classList.add('hidden');
      elements.quickCleanBtn.setAttribute('aria-hidden', 'true');
      elements.quickCleanBtn.onclick = null;
    }
  } catch (err) {
    console.error('Error rendering warning banner:', err);
  }
}

async function suspendSystemProcess(pid) {
  try {
    const res = await fetch('/api/system/suspend', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pid, confirm: true })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error?.message || 'שגיאה בהשהיית התהליך');
    showToast(`תהליך ${pid} מושהה בהצלחה`, 'success');
    logRecentAction('pause', `PID ${pid}`, `השהיית פעילות התהליך`);
    updateSystemUsage();
    if (activeFilter === 'system-resources') {
      fetchSystemProcesses();
    } else {
      fetchPorts();
    }
    return true;
  } catch (err) {
    showToast(err.message, 'error');
    return false;
  }
}

async function resumeSystemProcess(pid) {
  try {
    const res = await fetch('/api/system/resume', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pid })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error?.message || 'שגיאה בחידוש התהליך');
    showToast(`פעילות תהליך ${pid} חודשה בהצלחה`, 'success');
    logRecentAction('resume', `PID ${pid}`, `חידוש פעילות התהליך`);
    updateSystemUsage();
    if (activeFilter === 'system-resources') {
      fetchSystemProcesses();
    } else {
      fetchPorts();
    }
  } catch (err) {
    showToast(err.message, 'error');
  }
}

// --- UTILITIES ---
function escapeHtml(str) {
  if (!str) return '';
  return String(str).replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#039;');
}

function safeClassName(str) {
  return String(str || 'unknown').toLowerCase().replace(/[^a-z0-9_-]/g, '-');
}

function getUsageLabel(percentage, resource) {
  if (percentage > 85) return `${resource}: עומס חריג`;
  if (percentage > 70) return `${resource}: עומס גבוה`;
  if (percentage > 50) return `${resource}: עומס בינוני`;
  return `${resource}: תקין`;
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes)) return '-';
  return `${(bytes / (1024 ** 3)).toFixed(bytes >= 1024 ** 3 ? 1 : 2)} GB`;
}

function getProcessIcon(processName) {
  const name = (processName || '').toLowerCase();
  if (name.includes('node') || name.includes('npm')) {
    return `<span class="app-icon-badge app-icon-dev" title="Node.js"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width:16px;height:16px;"><path d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5"/></svg></span>`;
  }
  if (name.includes('python')) {
    return `<span class="app-icon-badge app-icon-python" title="Python"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width:16px;height:16px;"><polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/></svg></span>`;
  }
  if (name.includes('docker') || name.includes('dockerd')) {
    return `<span class="app-icon-badge app-icon-docker" title="Docker"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width:16px;height:16px;"><rect x="2" y="7" width="20" height="14" rx="2"/><path d="M16 3v4M8 3v4M12 3v4"/></svg></span>`;
  }
  if (name.includes('postgres') || name.includes('pg') || name.includes('redis') || name.includes('mysql') || name.includes('mongo')) {
    return `<span class="app-icon-badge app-icon-db" title="Database"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width:16px;height:16px;"><ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M21 12c0 1.66-4 3-9 3s-9-1.34-9-3"/><path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5"/></svg></span>`;
  }
  if (name.includes('chrome') || name.includes('chromium') || name.includes('firefox') || name.includes('safari')) {
    return `<span class="app-icon-badge app-icon-browser" title="Browser"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width:16px;height:16px;"><circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/></svg></span>`;
  }
  if (name.includes('port-manager') || name.includes('server.js')) {
    return `<span class="app-icon-badge app-icon-self" title="Port Manager"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width:16px;height:16px;"><path d="M12 2v8M12 14v8M2 12h8M14 12h8"/></svg></span>`;
  }
  return `<span class="app-icon-badge app-icon-system" title="System Process"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width:16px;height:16px;"><rect x="4" y="4" width="16" height="16" rx="2"/><rect x="9" y="9" width="6" height="6"/></svg></span>`;
}

function showToast(message, type = 'info') {
  announceUiStatus(message);
  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  toast.innerHTML = `
    <span>${escapeHtml(message)}</span>
    <button class="toast-close">&times;</button>
  `;

  const closeBtn = toast.querySelector('.toast-close');
  const dismiss = () => {
    toast.style.transform = 'translateY(10px) scale(0.9)';
    toast.style.opacity = '0';
    setTimeout(() => {
      if (toast.parentNode === elements.toastContainer) {
        elements.toastContainer.removeChild(toast);
      }
    }, 250);
  };

  closeBtn.addEventListener('click', dismiss);
  elements.toastContainer.appendChild(toast);

  // Auto-dismiss in 5s
  setTimeout(dismiss, 5000);
}

// Make showToast globally accessible for settings.js
window.showToast = showToast;

// --- UX REDESIGN SIMPLE VIEW IMPLEMENTATION ---

function getSimpleResourceSummary(processes) {
  const cpuTotal = processes.reduce((sum, process) => sum + Number(process.cpu || 0), 0);
  const memTotal = processes.reduce((sum, process) => sum + Number(process.memoryMb || 0), 0);
  return {
    cpu: parseFloat(cpuTotal.toFixed(1)),
    memoryMb: parseFloat(memTotal.toFixed(1))
  };
}

function createSimplePortSection(category, createRow) {
  const section = document.createElement('section');
  section.className = 'simple-port-section';

  const storedState = sessionStorage.getItem(category.sessionKey);
  const isExpanded = storedState === null ? category.defaultExpanded : storedState === 'true';
  const metrics = getSimpleResourceSummary(category.ports);

  section.innerHTML = `
    <button class="simple-port-section-toggle" id="${category.id}-toggle" type="button"
      aria-expanded="${isExpanded}" aria-controls="${category.id}-content">
      <span class="simple-port-section-summary">
        <span class="simple-port-section-title">${escapeHtml(category.title)}</span>
        ${category.subtitle ? `<span class="simple-port-section-subtitle">${escapeHtml(category.subtitle)}</span>` : ''}
        <span class="simple-port-section-count">${category.ports.length} פעילים</span>
        ${metrics.cpu > 0 || metrics.memoryMb > 0 ? `
        <span class="simple-port-section-metrics" dir="ltr">
          ${metrics.cpu > 0 ? `<span class="section-metric-cpu">CPU: ${metrics.cpu}%</span>` : ''}
          ${metrics.cpu > 0 && metrics.memoryMb > 0 ? '<span class="section-metric-sep">·</span>' : ''}
          ${metrics.memoryMb > 0 ? `<span class="section-metric-mem">${metrics.memoryMb} MB</span>` : ''}
        </span>` : ''}
      </span>
      <svg class="simple-port-section-chevron" aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <polyline points="6 9 12 15 18 9"></polyline>
      </svg>
    </button>
    <div class="simple-port-section-content" id="${category.id}-content" ${isExpanded ? '' : 'hidden'}>
      <div class="simple-port-list" role="list"></div>
    </div>
  `;

  const toggle = section.querySelector('.simple-port-section-toggle');
  const content = section.querySelector('.simple-port-section-content');
  const list = section.querySelector('.simple-port-list');

  category.ports.forEach((port) => list.appendChild(createRow(port)));

  toggle.addEventListener('click', () => {
    const nextExpanded = toggle.getAttribute('aria-expanded') !== 'true';
    toggle.setAttribute('aria-expanded', String(nextExpanded));
    content.hidden = !nextExpanded;
    sessionStorage.setItem(category.sessionKey, String(nextExpanded));
  });

  return section;
}

function appendSimplePortSection(container, category, createRow) {
  if (category.ports.length === 0) return;
  container.appendChild(createSimplePortSection(category, createRow));
}

function createSimplePortRow(portObj) {
  const row = document.createElement('div');
  const portNumber = Number(portObj.port);
  const portText = escapeHtml((portObj.ports || [portObj.port]).join(', '));
  const pidText = escapeHtml((portObj.pids || [portObj.pid]).join(', '));
  const isSelf = Boolean(portObj.isSelf) || portNumber === selfPort;
  const isSystemProcess = portObj.isSystem === true;
  const isReadOnlyMode = typeof window.SafetySettings !== 'undefined' && !window.SafetySettings.canKill();
  const isAggregate = portObj.isAggregate === true;
  const killDisabled = isAggregate || isSelf || isSystemProcess || isReadOnlyMode;
  const processIcon = getProcessIcon(portObj.processName);
  const project = portObj.project || null;
  const appName = project?.name || getFriendlyAppName(portObj);
  const sourceInfo = getSourceInfo(portObj);
  const listenerInfo = getListenerInfo(portObj);
  const actionRisk = assessProcessRisk(portObj);
  const cpu = Number(portObj.cpu || 0).toFixed(1);
  const memoryMb = Number(portObj.memoryMb || 0).toFixed(1);
  const projectDetail = project?.framework
    ? `${project.framework}${project.confidence === 'low' ? ' · זיהוי משוער' : ''}`
    : '';
  const portDesc = projectDetail || PORT_DESCRIPTIONS[portNumber] || (isSystemProcess ? 'שירות מערכת macOS' : 'תהליך ריצה');

  const hasSourcePath = sourceInfo.path && sourceInfo.path !== 'לא זמין' && sourceInfo.path !== '/';
  let sourceDisplay = sourceInfo.label;
  if (hasSourcePath) {
    const pathSegments = sourceInfo.path.split('/').filter(Boolean);
    sourceDisplay = pathSegments.slice(-2).join('/') || sourceInfo.path;
  }

  const exposureBadgeHtml = listenerInfo.label === 'מקומי בלבד'
    ? '<span class="simple-port-safety safe">גישה: רק מהמחשב הזה</span>'
    : '<span class="simple-port-safety exposed">גישה: זמינה ברשת</span>';
  const riskShortLabel = actionRisk.level === 'low' ? 'אפשר לעצור בבטחה' : actionRisk.level === 'medium' ? 'בדיקה לפני עצירה' : 'עצירה רגישה';
  const projectLabel = project?.location ? `פרויקט: ${project.name}` : (isSystemProcess ? 'רכיב macOS' : 'שירות מקומי');

  const isHttpPort = (portNumber >= 80 && portNumber <= 65535 && !isSystemProcess) || [80, 443, 3000, 5000, 5173, 8000, 8080, 9000, 4200, 11434].includes(portNumber);
  const openBrowserBtnHtml = isHttpPort && !isSystemProcess
    ? `<a href="${portNumber === 443 ? 'https' : 'http'}://localhost:${portNumber}" target="_blank" rel="noopener noreferrer" class="btn-open-browser" title="פתח שרת מקומי בטאב חדש בדפדפן">פתח בדפדפן ↗</a>`
    : '';

  let actionBtnHtml = '';
  if (isSelf) {
    actionBtnHtml = '<span class="simple-port-protected">מוגן: זהו מנהל הפורטים</span>';
  } else if (isSystemProcess) {
    actionBtnHtml = '<span class="simple-port-protected">מוגן על ידי macOS</span>';
  } else {
    actionBtnHtml = `<button class="simple-port-stop-btn port-card-kill-btn" type="button" ${killDisabled ? 'disabled' : ''} title="${escapeHtml(actionRisk.explanation)}">עצור שירות</button>`;
  }

  row.className = `simple-port-row${isSelf ? ' is-self' : ''}${isSystemProcess ? ' is-system' : ''}`;
  row.setAttribute('role', 'listitem');
  row.innerHTML = `
    <div class="simple-port-row-primary">
      <span class="simple-port-row-icon" aria-hidden="true">${processIcon}</span>
      <div class="simple-port-row-identity">
        <strong class="simple-port-row-title" dir="ltr">${escapeHtml(appName)}</strong>
        <span class="simple-port-row-description">${escapeHtml(projectLabel)} · ${escapeHtml(portDesc)}</span>
      </div>
      <span class="simple-port-port" dir="ltr">פורט ${portText}</span>
    </div>
    <div class="simple-port-row-meta">
      ${exposureBadgeHtml}
      <span class="simple-port-risk risk-${actionRisk.level}" title="${escapeHtml(actionRisk.explanation)}">${riskShortLabel}</span>
      <span class="simple-port-meta-item" title="${escapeHtml(project?.location || sourceInfo.path)}" ${(project?.location || hasSourcePath) ? 'dir="ltr"' : ''}>${escapeHtml(project?.location ? project.location.split('/').filter(Boolean).slice(-2).join('/') : sourceDisplay)}</span>
      <span class="simple-port-meta-item" dir="ltr">PID ${pidText}</span>
      ${Number(cpu) > 0 ? `<span class="simple-port-meta-item metric-cpu" dir="ltr">CPU ${cpu}%</span>` : ''}
      ${Number(memoryMb) > 0 ? `<span class="simple-port-meta-item metric-memory" dir="ltr">${memoryMb} MB</span>` : ''}
    </div>
    <div class="simple-port-row-actions">
      ${openBrowserBtnHtml}
      <button class="simple-port-details-btn btn-details-action" type="button">פרטים טכניים</button>
      ${actionBtnHtml}
    </div>
  `;

  row.querySelector('.btn-details-action').addEventListener('click', () => openDetailsModal(portObj));
  const killBtn = row.querySelector('.port-card-kill-btn');
  if (killBtn && !killDisabled) {
    killBtn.addEventListener('click', () => openConfirmModal('kill', portObj));
  }

  return row;
}

function createSimpleSystemProcessRow(process) {
  const row = document.createElement('div');
  const isReadOnlyMode = typeof window.SafetySettings !== 'undefined' && !window.SafetySettings.canKill();
  const isProtected = process.isSystem === true;
  const status = process.isSuspended ? 'מושהה' : 'פעיל';
  const actionHtml = isProtected
    ? '<span class="simple-port-protected">מוגן מערכת</span>'
    : `<button class="simple-port-pause-btn ${process.isSuspended ? 'btn-resume-simple' : 'btn-pause-simple'}" type="button">${process.isSuspended ? 'המשך' : 'השהיה'}</button>
       <button class="simple-port-stop-btn btn-kill-proc" type="button" ${isReadOnlyMode ? 'disabled' : ''}>כבה תהליך</button>`;

  row.className = `simple-port-row simple-process-row${isProtected ? ' is-system' : ''}`;
  row.setAttribute('role', 'listitem');
  row.innerHTML = `
    <div class="simple-port-row-primary">
      <span class="simple-port-row-icon" aria-hidden="true">${getProcessIcon(process.processName)}</span>
      <div class="simple-port-row-identity">
        <strong class="simple-port-row-title" dir="ltr">${escapeHtml(process.processName)}</strong>
        <span class="simple-port-row-description">משתמש: ${escapeHtml(process.user || 'לא זמין')}</span>
      </div>
    </div>
    <div class="simple-port-row-meta">
      <span class="simple-port-safety ${process.isSuspended ? 'exposed' : 'safe'}">סטטוס: ${status}</span>
      <span class="simple-port-meta-item" dir="ltr">PID ${escapeHtml(String(process.pid))}</span>
      ${Number(process.cpu || 0) > 0 ? `<span class="simple-port-meta-item metric-cpu" dir="ltr">CPU ${Number(process.cpu || 0).toFixed(1)}%</span>` : ''}
      ${Number(process.memoryMb || 0) > 0 ? `<span class="simple-port-meta-item metric-memory" dir="ltr">${Number(process.memoryMb || 0).toFixed(1)} MB</span>` : ''}
    </div>
    <div class="simple-port-row-actions">${actionHtml}</div>
  `;

  const killBtn = row.querySelector('.btn-kill-proc');
  if (killBtn && !isReadOnlyMode) {
    killBtn.addEventListener('click', () => {
      openConfirmModal('kill', {
        pid: process.pid,
        processName: process.processName,
        commandLine: process.commandLine || process.processName,
        port: '-'
      });
    });
  }

  const pauseBtn = row.querySelector('.btn-pause-simple');
  if (pauseBtn) {
    pauseBtn.addEventListener('click', () => openSuspendConfirmModal(process));
  }
  const resumeBtn = row.querySelector('.btn-resume-simple');
  if (resumeBtn) {
    resumeBtn.addEventListener('click', () => resumeSystemProcess(process.pid));
  }

  return row;
}

function renderCompactSimpleSystemProcesses() {
  const cardsContainer = document.getElementById('ports-cards-container');
  cardsContainer.innerHTML = '';
  if (filteredProcesses.length === 0) {
    elements.emptyState.classList.remove('hidden');
    return;
  }

  elements.emptyState.classList.add('hidden');
  const simpleSummaryText = document.getElementById('simple-summary-text');
  if (simpleSummaryText) simpleSummaryText.textContent = `מציג ${filteredProcesses.length} תהליכי מערכת ומשאבים.`;

  appendSimplePortSection(cardsContainer, {
    id: 'category-system-resources',
    title: 'תהליכי מערכת ומשאבים',
    ports: filteredProcesses,
    defaultExpanded: true,
    sessionKey: 'accordion_system_resources_expanded'
  }, createSimpleSystemProcessRow);
}

function renderCompactSimplePorts() {
  const cardsContainer = document.getElementById('ports-cards-container');
  cardsContainer.innerHTML = '';
  if (filteredPorts.length === 0) {
    elements.emptyState.classList.remove('hidden');
    return;
  }

  elements.emptyState.classList.add('hidden');
  const userPorts = filteredPorts.filter((port) => !port.isSystem);
  const systemPorts = filteredPorts.filter((port) => port.isSystem);
  const simpleSummaryText = document.getElementById('simple-summary-text');
  if (simpleSummaryText) simpleSummaryText.textContent = `מציג ${filteredPorts.length} תהליכים פעילים לפי קבוצה.`;

  const projectGroups = new Map();
  const supportingServices = { id: 'category-support', title: 'שירותי עזר מקומיים', subtitle: 'מסדי נתונים, Docker ושירותים ללא תיקיית פרויקט', ports: [], defaultExpanded: false, sessionKey: 'accordion_support_expanded' };

  userPorts.forEach((portObj) => {
    const name = (portObj.processName || '').toLowerCase();
    const command = (portObj.commandLine || '').toLowerCase();
    const portNumber = Number(portObj.port);
    const description = PORT_DESCRIPTIONS[portNumber] || '';
    const isDatabase = portObj.project?.serviceType === 'database' || portObj.project?.serviceType === 'container-service' || name.includes('postgres') || name.includes('pg') || name.includes('mysql') || name.includes('redis') || name.includes('mongo') || name.includes('elastic') || name.includes('sql') || name.includes('docker') || name.includes('dockerd') || [3306, 5432, 6379, 27017, 9200].includes(portNumber) || description.includes('נתונים') || description.includes('Redis');
    const isApplication = name.includes('chrome') || name.includes('chromium') || name.includes('firefox') || name.includes('safari') || name.includes('browser') || name.includes('slack') || name.includes('spotify') || name.includes('electron') || name.includes('discord') || command.includes('.app/contents/macos/');
    const isDevelopment = portObj.project?.serviceType === 'development-server' || name.includes('node') || name.includes('npm') || name.includes('python') || name.includes('vite') || name.includes('ruby') || name.includes('go') || name.includes('gopls') || name.includes('port-manager') || name.includes('server.js') || [80, 443, 3000, 5000, 5173, 7000, 8000, 8080, 9000].includes(portNumber) || description.includes('פיתוח') || description.includes('שרת');

    const project = portObj.project;
    const isProjectService = project?.location && (project.serviceType === 'development-server' || isDevelopment) && !isDatabase && !isApplication;
    if (isProjectService) {
      const key = project.location;
      if (!projectGroups.has(key)) {
        projectGroups.set(key, {
          id: `project-${key.replace(/[^a-zA-Z0-9_-]/g, '-').slice(-72)}`,
          title: project.name || 'פרויקט מקומי',
          subtitle: `${project.framework || 'שירות פיתוח'} · ${project.location.split('/').filter(Boolean).slice(-2).join('/')}`,
          ports: [],
          defaultExpanded: true,
          sessionKey: `accordion_project_${key}`
        });
      }
      projectGroups.get(key).ports.push(portObj);
    } else {
      supportingServices.ports.push(portObj);
    }
  });

  if (activeFilter !== 'system') {
    [...projectGroups.values()].sort((a, b) => a.title.localeCompare(b.title)).forEach((category) => appendSimplePortSection(cardsContainer, category, createSimplePortRow));
    appendSimplePortSection(cardsContainer, supportingServices, createSimplePortRow);
  }
  if (activeFilter !== 'user') {
    appendSimplePortSection(cardsContainer, {
      id: 'category-system',
      title: 'תהליכים מוגנים של macOS',
      subtitle: 'מוצגים לצפייה בלבד — לא ניתן לעצור אותם מכאן',
      ports: systemPorts,
      defaultExpanded: activeFilter === 'system',
      sessionKey: 'accordion_system_expanded'
    }, createSimplePortRow);
  }
}

function setupViewModeToggle() {
  const btnSimple = document.getElementById('view-mode-simple');
  const btnDetailed = document.getElementById('view-mode-detailed');

  if (!btnSimple || !btnDetailed) return;

  function setMode(mode) {
    viewMode = mode;
    localStorage.setItem('viewMode', mode);

    if (mode === 'simple') {
      document.body.classList.add('view-simple');
      document.body.classList.remove('view-detailed');
      btnSimple.classList.add('active');
      btnSimple.setAttribute('aria-checked', 'true');
      btnDetailed.classList.remove('active');
      btnDetailed.setAttribute('aria-checked', 'false');
    } else {
      document.body.classList.add('view-detailed');
      document.body.classList.remove('view-simple');
      btnSimple.classList.remove('active');
      btnSimple.setAttribute('aria-checked', 'false');
      btnDetailed.classList.add('active');
      btnDetailed.setAttribute('aria-checked', 'true');
    }

    // Rerender table / cards
    renderTable();
  }

  btnSimple.addEventListener('click', () => setMode('simple'));
  btnDetailed.addEventListener('click', () => setMode('detailed'));

  // Set initial state
  setMode(viewMode);
}

// ─── ACTIVITY MONITOR TAB HELPERS ──────────────────────────────────────────

let activityMonitorData = null;

function focusCurrentTabSearch() {
  const activeTab = document.documentElement.dataset.activeTab || 'ports';
  const inputId = activeTab === 'ports' ? 'search-input'
    : activeTab === 'cache' ? 'cache-search-input'
    : `${activeTab}-search-input`;
  const input = document.getElementById(inputId);
  if (input) {
    input.focus();
    if (typeof input.select === 'function') input.select();
  }
}

async function fetchActivityMonitorTab(tabName, { force = false } = {}) {
  try {
    activityMonitorData = await resourceClient.getJson('activity-monitor', '/api/system/activity-monitor', { force });
    if (getActiveTab() !== tabName) return;
    renderActivityMonitorTab(tabName, activityMonitorData);
  } catch (err) {
    if (err?.name === 'AbortError') return;
    console.error('Failed to fetch activity monitor data:', err);
    const tbody = document.getElementById(`${tabName}-table-body`);
    const count = document.getElementById(`${tabName}-results-count`);
    if (tbody) tbody.innerHTML = '<tr><td colspan="7" class="loading-state">לא ניתן לעדכן את הנתונים כרגע. מוצגים רק נתונים קודמים, אם קיימים.</td></tr>';
    if (count) count.textContent = 'העדכון נכשל — נסה לרענן';
    announceUiStatus('לא ניתן לעדכן את נתוני פעילות המערכת. נסה לרענן שוב.');
    showToast('עדכון פעילות המערכת נכשל. הנתונים אינם עדכניים.', 'warning');
  }
}

function updateVibeCoderSummaryCards(tabName, data) {
  if (!data) return;

  if (tabName === 'cpu' && data.cpu) {
    const usage = Number(data.cpu.usagePercentage || 0).toFixed(1);
    const topProc = data.cpu.topProcesses && data.cpu.topProcesses[0];
    const cpuVal = document.getElementById('vibe-cpu-val');
    const cpuBadge = document.getElementById('vibe-cpu-badge');
    const topName = document.getElementById('vibe-cpu-top-name');
    const topUsage = document.getElementById('vibe-cpu-top-usage');
    const advice = document.getElementById('vibe-cpu-advice');

    if (cpuVal) cpuVal.textContent = `${usage}%`;
    if (cpuBadge) {
      if (usage > 75) {
        cpuBadge.className = 'vibe-badge vibe-badge-danger';
        cpuBadge.textContent = 'עומס כבד';
      } else if (usage > 40) {
        cpuBadge.className = 'vibe-badge vibe-badge-warning';
        cpuBadge.textContent = 'עומס בינוני';
      } else {
        cpuBadge.className = 'vibe-badge vibe-badge-success';
        cpuBadge.textContent = 'תקין';
      }
    }
    if (topName && topProc) {
      topName.textContent = topProc.humanTitle || topProc.processName || '---';
    }
    if (topUsage && topProc) {
      topUsage.textContent = `שימוש CPU: ${topProc.cpu}% · PID ${topProc.pid}`;
    }
    if (advice) {
      advice.textContent = usage > 70 
        ? `זוהה עומס מעבד של ${usage}%. מומלץ לבדוק את התהליך ${topProc?.processName || ''}.`
        : 'המעבד פנוי, עבודה חלקה במהירות מלאה.';
    }
  }

  if (tabName === 'memory' && data.memory) {
    const usedGb = (Number(data.memory.usedBytes || 0) / (1024 ** 3)).toFixed(1);
    const totalGb = (Number(data.memory.totalBytes || 1) / (1024 ** 3)).toFixed(0);
    const topProc = data.memory.topProcesses && data.memory.topProcesses[0];
    const memVal = document.getElementById('vibe-memory-val');
    const memBadge = document.getElementById('vibe-memory-badge');
    const topName = document.getElementById('vibe-memory-top-name');
    const topUsage = document.getElementById('vibe-memory-top-usage');
    const advice = document.getElementById('vibe-memory-advice');

    if (memVal) memVal.textContent = `${usedGb} GB מתוך ${totalGb} GB`;
    if (memBadge) {
      const pct = data.memory.percentage || 0;
      if (pct > 80) {
        memBadge.className = 'vibe-badge vibe-badge-warning';
        memBadge.textContent = 'לחץ זיכרון';
      } else {
        memBadge.className = 'vibe-badge vibe-badge-success';
        memBadge.textContent = 'מאוזן';
      }
    }
    if (topName && topProc) {
      topName.textContent = topProc.humanTitle || topProc.processName || '---';
    }
    if (topUsage && topProc) {
      topUsage.textContent = `צריכה: ${topProc.memoryMb || topProc.memory || '--'} MB · PID ${topProc.pid}`;
    }
    if (advice) {
      advice.textContent = 'יש מספיק RAM פנוי לכל השרתים והכלים.';
    }
  }

  if (tabName === 'energy' && data.energy) {
    const topProc = data.energy.topProcesses && data.energy.topProcesses[0];
    const energyVal = document.getElementById('vibe-energy-val');
    const topName = document.getElementById('vibe-energy-top-name');
    const topUsage = document.getElementById('vibe-energy-top-usage');

    if (energyVal) energyVal.textContent = 'תקין';
    if (topName && topProc) {
      topName.textContent = topProc.humanTitle || topProc.processName || '---';
    }
    if (topUsage && topProc) {
      topUsage.textContent = `השפעה: ${topProc.energyImpact || 'נמוכה'} · CPU ${topProc.cpu}%`;
    }
  }

  if (tabName === 'disk' && data.disk) {
    const usedGb = (Number(data.disk.usedBytes || 0) / (1024 ** 3)).toFixed(1);
    const diskVal = document.getElementById('vibe-disk-val');
    if (diskVal) diskVal.textContent = `${usedGb} GB בשימוש`;
  }
}

function renderActivityMonitorTab(tabName, data) {
  if (!data) return;
  updateVibeCoderSummaryCards(tabName, data);
  applyActivityFilters(tabName);
}

function applyActivityFilters(tabName) {
  if (!activityMonitorData || !activityMonitorData[tabName]) return;
  const { query, filter } = activityFilters[tabName] || { query: '', filter: 'all' };
  const list = tabName === 'cpu' ? activityMonitorData.cpu.topProcesses
    : tabName === 'memory' ? activityMonitorData.memory.topProcesses
    : tabName === 'energy' ? activityMonitorData.energy.topProcesses
    : activityMonitorData.disk.topProcesses;

  if (!list) return;

  const filtered = list.filter(proc => {
    if (query) {
      const searchStr = `${proc.processName} ${proc.humanTitle || ''} ${proc.humanDescription || ''} ${proc.pid} ${proc.user || ''} ${proc.commandLine || ''}`.toLowerCase();
      if (!searchStr.includes(query)) return false;
    }

    const isSystem = proc.isSystem === true || proc.safetyCategory === 'SYSTEM_PROTECTED' || proc.user === 'root' || proc.user === 'windowserver_';
    const isVerified = proc.safetyCategory === 'SAFE' || proc.isVerified === true;

    if (filter === 'user') {
      return !isSystem;
    } else if (filter === 'system') {
      return isSystem;
    } else if (filter === 'verified') {
      return isVerified;
    } else if (filter === 'caution') {
      return proc.safetyCategory === 'CAUTION' || isSystem;
    }

    return true;
  });

  renderActivityTable(tabName, filtered);
}

function filterActivityTable(tabName, query) {
  if (activityFilters[tabName]) {
    activityFilters[tabName].query = query;
  }
  applyActivityFilters(tabName);
}

function renderActivityTable(tabName, processes) {
  const tbody = document.getElementById(`${tabName}-table-body`);
  const countEl = document.getElementById(`${tabName}-results-count`);
  if (!tbody) return;

  if (countEl) {
    countEl.textContent = `מוצגים ${processes.length} תהליכים`;
  }

  if (processes.length === 0) {
    tbody.innerHTML = `<tr><td colspan="7" class="loading-state">לא נמצאו תהליכים מתאימים</td></tr>`;
    return;
  }

  tbody.innerHTML = processes.map(proc => {
    const isSystem = proc.isSystem === true || proc.safetyCategory === 'SYSTEM_PROTECTED' || proc.user === 'root' || proc.user === 'windowserver_';
    const isVerified = proc.safetyCategory === 'SAFE' || proc.isVerified === true;
    const safetyBadge = isSystem
      ? '<span class="safety-badge system-protected" title="מאומת: תהליך מוגן של מערכת ההפעלה macOS">⚙️ macOS מוגן</span>'
      : isVerified
        ? '<span class="safety-badge safe" title="מאומת: אפליקציית משתמש מאושרת לחלוטין">🛡️ מאומת</span>'
        : proc.safetyCategory === 'CAUTION'
          ? '<span class="safety-badge caution" title="תהליך פיתוח/שרת מקומי - מומלץ לבדוק לפני סגירה">⚠️ זהירות</span>'
          : '<span class="safety-badge safe" title="אפליקציית משתמש רגילה">🟢 בטוח</span>';

    const killDisabled = isSystem;
    const suspendDisabled = isSystem;

    let cellsHtml = '';
    if (tabName === 'cpu') {
      cellsHtml = `
        <td>
          <div class="process-info-cell">
            <strong class="process-title">${escapeHtml(proc.humanTitle || proc.processName)}</strong>
            <span class="process-subtitle">${escapeHtml(proc.humanDescription || proc.commandLine || '')}</span>
          </div>
        </td>
        <td><code>${proc.pid}</code></td>
        <td><span class="metric-highlight">${proc.cpu}%</span></td>
        <td>${proc.energyImpact || 0}</td>
        <td>${escapeHtml(proc.user || '-')}</td>
        <td>${safetyBadge}</td>
      `;
    } else if (tabName === 'memory') {
      cellsHtml = `
        <td>
          <div class="process-info-cell">
            <strong class="process-title">${escapeHtml(proc.humanTitle || proc.processName)}</strong>
            <span class="process-subtitle">${escapeHtml(proc.humanDescription || proc.commandLine || '')}</span>
          </div>
        </td>
        <td><code>${proc.pid}</code></td>
        <td><span class="metric-highlight">${proc.memoryMb} MB</span></td>
        <td>${escapeHtml(proc.user || '-')}</td>
        <td>${safetyBadge}</td>
      `;
    } else if (tabName === 'energy') {
      cellsHtml = `
        <td>
          <div class="process-info-cell">
            <strong class="process-title">${escapeHtml(proc.humanTitle || proc.processName)}</strong>
            <span class="process-subtitle">${escapeHtml(proc.humanDescription || proc.commandLine || '')}</span>
          </div>
        </td>
        <td><code>${proc.pid}</code></td>
        <td><span class="metric-highlight">${proc.energyImpact || 0}</span></td>
        <td>${proc.cpu}%</td>
        <td>${safetyBadge}</td>
      `;
    } else if (tabName === 'disk') {
      cellsHtml = `
        <td>
          <div class="process-info-cell">
            <strong class="process-title">${escapeHtml(proc.humanTitle || proc.processName)}</strong>
            <span class="process-subtitle">${escapeHtml(proc.humanDescription || proc.commandLine || '')}</span>
          </div>
        </td>
        <td><code>${proc.pid}</code></td>
        <td><span class="metric-highlight">${proc.memoryMb} MB</span></td>
        <td>${escapeHtml(proc.user || '-')}</td>
        <td>${safetyBadge}</td>
      `;
    }

    const actionCell = `
      <td>
        <div class="action-buttons-group">
          <button class="btn btn-secondary btn-xs suspend-btn" data-pid="${proc.pid}" ${suspendDisabled ? 'disabled' : ''} title="${proc.isSuspended ? 'המשך ריצה' : 'השהה תהליך'}">
            ${proc.isSuspended ? '▶️ המשך' : '⏸️ השהה'}
          </button>
          <button class="btn btn-danger btn-xs kill-proc-btn" data-pid="${proc.pid}" data-name="${escapeHtml(proc.humanTitle || proc.processName)}" ${killDisabled ? 'disabled' : ''} title="סגור תהליך">
            ❌ סגור
          </button>
        </div>
      </td>
    `;

    return `<tr>${cellsHtml}${actionCell}</tr>`;
  }).join('');

  tbody.querySelectorAll('.suspend-btn').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      const pid = Number(e.currentTarget.dataset.pid);
      if (!pid) return;
      const proc = processes.find(p => p.pid === pid);
      if (proc && proc.isSuspended) {
        await resumeSystemProcess(pid);
      } else {
        // Suspending is destructive enough to require the same explicit sheet
        // used from the primary processes view.
        if (proc) openSuspendConfirmModal(proc);
        return;
      }
      fetchActivityMonitorTab(tabName);
    });
  });

  tbody.querySelectorAll('.kill-proc-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      const pid = Number(e.currentTarget.dataset.pid);
      const name = e.currentTarget.dataset.name;
      if (pid) {
        openConfirmModal('kill', { pid, processName: name || 'Process', commandLine: name || 'Unknown', port: '-' });
      }
    });
  });
}

function filterActivityTable(tabName, query) {
  if (!activityMonitorData) return;
  const list = tabName === 'cpu' ? activityMonitorData.cpu.topProcesses
    : tabName === 'memory' ? activityMonitorData.memory.topProcesses
    : tabName === 'energy' ? activityMonitorData.energy.topProcesses
    : activityMonitorData.disk.topProcesses;

  const filtered = list.filter(proc => {
    const searchStr = `${proc.processName} ${proc.humanTitle || ''} ${proc.humanDescription || ''} ${proc.pid} ${proc.commandLine || ''}`.toLowerCase();
    return searchStr.includes(query);
  });

  renderActivityMonitorTab(tabName, {
    ...activityMonitorData,
    [tabName]: {
      ...activityMonitorData[tabName],
      topProcesses: filtered
    }
  });
}

async function copyAiSummary() {
  try {
    const res = await fetch('/api/system/activity-monitor');
    if (!res.ok) throw new Error('Network error');
    const data = await res.json();

    const portsList = (allPorts || []).slice(0, 15).map(p => {
      const dev = detectDevStack(p);
      const tag = dev ? ` [${dev.name}]` : '';
      return `  - Port ${p.port}: ${p.processName || p.name || 'Unknown'} (PID ${p.pid})${tag}`;
    }).join('\n');

    const summaryText = `### 💻 macOS Dev Environment & Ports Summary (Vibe Coding Context)
**Timestamp:** ${new Date(data.timestamp).toLocaleString('he-IL')}

#### 🌐 Active Network Ports & Dev Stack:
- **Active Ports Count:** ${data.network?.activePortsCount || (allPorts ? allPorts.length : 0)}
${portsList || '  - No active dev ports detected.'}

#### 📊 System Resources & Activity:
- **CPU Load:** ${data.cpu?.usagePercentage}% (${data.cpu?.activeProcessesCount} active processes)
- **Top CPU Processes:** ${data.cpu?.topProcesses.slice(0, 3).map(p => `${p.humanTitle || p.processName} (${p.cpu}%)`).join(', ') || 'N/A'}
- **Memory Used:** ${(data.memory?.usedBytes / 1073741824).toFixed(1)} GB / ${(data.memory?.totalBytes / 1073741824).toFixed(1)} GB (${data.memory?.percentage}%) [Pressure: ${data.memory?.pressure || 'Normal'}]
- **Disk Usage:** ${(data.disk?.usedBytes / 1073741824).toFixed(1)} GB / ${(data.disk?.totalBytes / 1073741824).toFixed(1)} GB (${data.disk?.percentage}%)
`;

    await navigator.clipboard.writeText(summaryText);
    showToast('🚀 סיכום סביבת הפיתוח והפורטים הועתק ללוח בפורמט מותאם ל-AI!', 'success');
  } catch (err) {
    showToast('נכשלה העתקת סיכום המערכת', 'error');
  }
}
