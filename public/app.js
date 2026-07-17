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
let appUpdateSupported = false;
const POLL_INTERVAL = 8000; // 8 seconds
const SYSTEM_USAGE_INTERVAL = 4000; // 4 seconds

// Self Port detection based on the loaded URL
const selfPort = parseInt(window.location.port, 10) || 9999;

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

function getFriendlyAppName(portObj) {
  const command = portObj.commandLine || '';
  const appMatch = command.match(/\/([^/]+)\.app\/Contents\/MacOS\//);
  if (appMatch) return appMatch[1];

  const scriptMatch = command.match(/(?:^|\s)(?:node|python3?|ruby)\s+(\S+)/);
  if (scriptMatch && !scriptMatch[1].startsWith('-')) return scriptMatch[1].split('/').pop();

  if (/^language[_-]/i.test(portObj.processName || '')) return 'שירות שפה של סביבת פיתוח';

  return portObj.processName || 'תהליך לא מזוהה';
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
  searchInput: document.getElementById('search-input'),
  filterTabs: document.querySelectorAll('.filter-tab'),
  emptyState: document.getElementById('empty-state'),
  toastContainer: document.getElementById('toast-container'),
  
  // Metrics
  metricActiveCount: document.getElementById('metric-active-count'),
  metricUserCount: document.getElementById('metric-user-count'),
  metricSystemCount: document.getElementById('metric-system-count'),
  
  // Metrics CPU/Memory
  metricCpuUsage: document.getElementById('metric-cpu-usage'),
  metricCpuDetail: document.getElementById('metric-cpu-detail'),
  cpuBar: document.getElementById('cpu-bar'),
  metricMemoryUsage: document.getElementById('metric-memory-usage'),
  metricMemoryDetail: document.getElementById('metric-memory-detail'),
  memoryBar: document.getElementById('memory-bar'),
  metricDiskUsage: document.getElementById('metric-disk-usage'),
  metricDiskDetail: document.getElementById('metric-disk-detail'),
  metricCacheUsage: document.getElementById('metric-cache-usage'),
  metricCacheDetail: document.getElementById('metric-cache-detail'),
  cacheFindings: document.getElementById('cache-findings'),
  storageRefreshBtn: document.getElementById('storage-refresh-btn'),
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
  specCommand: document.getElementById('spec-command')
};

// --- INITIALIZATION ---
document.addEventListener('DOMContentLoaded', () => {
  setupEventListeners();
  fetchAppInfo();
  fetchPorts();
  startPolling();
  updateSystemUsage();
  startSystemUsagePolling();
  updateStorageUsage();
});

async function fetchAppInfo() {
  if (elements.copyrightYear) {
    elements.copyrightYear.textContent = String(new Date().getFullYear());
  }

  try {
    const response = await fetch('/api/app-info');
    if (!response.ok) throw new Error('App info unavailable');
    const info = await response.json();
    elements.currentVersion.textContent = info.currentVersion || '—';
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
  } catch (_error) {
    elements.updateStatus.textContent = 'לא ניתן לבדוק עדכונים כרגע';
  }
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

    elements.updateStatus.textContent = 'העדכון אומת — מפעיל מחדש…';
    elements.updateButton.classList.add('hidden');
  } catch (error) {
    console.error('Could not apply app update:', error);
    elements.updateStatus.textContent = 'העדכון נכשל — אפשר לנסות שוב';
    elements.updateStatus.classList.add('available');
    elements.updateButton.disabled = false;
    elements.updateButton.textContent = 'נסה שוב';
    showToast(`העדכון נכשל: ${error.message}`, 'error');
  }
}

function setupEventListeners() {
  setupViewModeToggle();
  elements.updateButton.addEventListener('click', applyAppUpdate);

  // Refresh button
  elements.refreshBtn.addEventListener('click', () => {
    fetchPorts();
    updateStorageUsage();
  });
  elements.storageRefreshBtn.addEventListener('click', updateStorageUsage);

  // Search input
  elements.searchInput.addEventListener('input', (e) => {
    searchQuery = e.target.value.toLowerCase().trim();
    applyFilters();
  });

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
  elements.confirmPidInput.addEventListener('input', validateDestructiveConfirmation);
  elements.confirmUnderstandCheckbox.addEventListener('change', validateDestructiveConfirmation);
  elements.confirmModal.addEventListener('click', (e) => {
    if (e.target === elements.confirmModal) closeConfirmModal();
  });

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
}

// --- POLLING LOGIC ---
function startPolling() {
  stopPolling();
  pollIntervalId = setInterval(fetchPortsSilent, POLL_INTERVAL);
}

function stopPolling() {
  if (pollIntervalId) {
    clearInterval(pollIntervalId);
    pollIntervalId = null;
  }
}

function startSystemUsagePolling() {
  stopSystemUsagePolling();
  systemUsageIntervalId = setInterval(updateSystemUsage, SYSTEM_USAGE_INTERVAL);
}

function stopSystemUsagePolling() {
  if (systemUsageIntervalId) {
    clearInterval(systemUsageIntervalId);
    systemUsageIntervalId = null;
  }
}

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
    const group = groups.get(key) || { ...item, ports: [], pids: [], addresses: [] };
    if (!group.ports.includes(item.port)) group.ports.push(item.port);
    if (!group.pids.includes(item.pid)) group.pids.push(item.pid);
    if (item.address && !group.addresses.includes(item.address)) group.addresses.push(item.address);
    groups.set(key, group);
  }
  return [...groups.values()].map(group => ({
    ...group,
    ports: group.ports.sort((a, b) => a - b),
    pids: group.pids.sort((a, b) => a - b),
    instanceCount: group.pids.length,
    isAggregate: group.pids.length > 1,
  }));
}

// --- DATA FETCHING ---
async function fetchPorts() {
  if (activeFilter === 'system-resources') {
    return fetchSystemProcesses();
  }

  // Show loading spinner in Hebrew
  elements.tableBody.innerHTML = `
    <tr>
      <td colspan="8" class="loading-state">
        <div class="spinner"></div>
        סורק פורטים פעילים ב-macOS...
      </td>
    </tr>
  `;
  elements.emptyState.classList.add('hidden');
  
  try {
    const response = await fetch('/api/ports');
    if (!response.ok) throw new Error('שגיאה בתקשורת עם השרת');
    const data = await response.json();
    portsData = data.ports || [];
    applyFilters();
  } catch (err) {
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
async function fetchPortsSilent() {
  // Do not poll if a modal is visible
  if (!elements.confirmModal.classList.contains('hidden') || !elements.detailsModal.classList.contains('hidden')) {
    return;
  }

  try {
    const isSystemRes = activeFilter === 'system-resources';
    const url = isSystemRes ? '/api/system/processes' : '/api/ports';
    const response = await fetch(url);
    if (!response.ok) throw new Error('Silent fetch failed');
    const data = await response.json();
    if (isSystemRes) {
      systemProcessesData = data.processes || [];
    } else {
      portsData = data.ports || [];
    }
    applyFilters();
  } catch (err) {
    console.warn('Silent refresh failed:', err);
  }
}

async function fetchSystemProcesses() {
  elements.tableBody.innerHTML = `
    <tr>
      <td colspan="8" class="loading-state">
        <div class="spinner"></div>
        סורק תהליכי מערכת ומשאבים ב-macOS...
      </td>
    </tr>
  `;
  elements.emptyState.classList.add('hidden');
  
  try {
    const response = await fetch('/api/system/processes');
    if (!response.ok) throw new Error('שגיאה בתקשורת עם השרת');
    const data = await response.json();
    systemProcessesData = data.processes || [];
    applyFilters();
  } catch (err) {
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
    filteredProcesses = systemProcessesData.filter(proc => {
      if (searchQuery) {
        const pidStr = String(proc.pid);
        const name = (proc.processName || '').toLowerCase();
        const cmd = (proc.commandLine || '').toLowerCase();
        const user = (proc.user || '').toLowerCase();
        
        return pidStr.includes(searchQuery) ||
               name.includes(searchQuery) ||
               cmd.includes(searchQuery) ||
               user.includes(searchQuery);
      }
      return true;
    });
    updateResultsSummary(filteredProcesses.length);
    
    sortAndRender();
    return;
  }

  filteredPorts = portsData.filter(portObj => {
    // 1. Tab filter
    if (activeFilter === 'system' && !portObj.isSystem) return false;
    if (activeFilter === 'user' && portObj.isSystem) return false;

    // 2. Search query filter
    if (searchQuery) {
      const portStr = String(portObj.port);
      const pidStr = String(portObj.pid);
      const name = (portObj.processName || '').toLowerCase();
      const cmd = (portObj.commandLine || '').toLowerCase();
      const user = (portObj.user || '').toLowerCase();
      const source = getSourceInfo(portObj).path.toLowerCase();
      const listener = getListenerInfo(portObj).label.toLowerCase();
      
      const match = portStr.includes(searchQuery) ||
                    pidStr.includes(searchQuery) ||
                    name.includes(searchQuery) ||
                    cmd.includes(searchQuery) ||
                    user.includes(searchQuery) ||
                    source.includes(searchQuery) ||
                    listener.includes(searchQuery);
      if (!match) return false;
    }

    return true;
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
        : `סגור תהליך PID ${proc.pid} — דורש הקלדת אישור.`;
        
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
        pauseBtn.addEventListener('click', () => suspendSystemProcess(proc.pid));
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
      renderSimpleSystemProcesses();
    } else {
      renderSimpleCards();
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
          : `סגור תהליך PID ${portObj.pid} בפורט ${portObj.port} — דורש הקלדת אישור.`;

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
  
  // Clean elements
  elements.previewPort.textContent = portObj.port !== undefined ? portObj.port : '-';
  elements.previewProcess.textContent = portObj.processName;
  elements.previewPid.textContent = portObj.pid;
  elements.previewCommand.textContent = portObj.commandLine;

  // Prepare confirmation gate
  resetDestructiveConfirmation();
  destructiveActionContext = { action, pid: String(portObj.pid) };
  elements.confirmRequiredPid.textContent = String(portObj.pid);

  if (action === 'kill') {
    elements.modalTitle.textContent = 'אישור סגירת תוכנה ותהליך';
    const portDesc = portObj.port && portObj.port !== '-' ? ` בפורט <strong>${portObj.port}</strong>` : '';
    elements.modalDesc.innerHTML = `פעולה זו תשלח אות כיבוי (<code>SIGTERM</code>) למזהה תהליך (PID) <strong>${portObj.pid}</strong>${portDesc}. סגור את התוכנה רק אם אתה בטוח שהיא אינה חיונית לפעילותך.`;
    elements.modalConfirmBtn.textContent = 'סגור תוכנה (Terminate)';
    elements.modalConfirmBtn.className = 'btn btn-danger';
    elements.modalConfirmBtn.disabled = true;
    
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
}

function validateDestructiveConfirmation(portObj = null) {
  const activeAction = portObj && typeof portObj.pid !== 'undefined'
    ? 'kill'
    : destructiveActionContext?.action;
  const requiredPid = portObj && typeof portObj.pid !== 'undefined'
    ? String(portObj.pid)
    : destructiveActionContext?.pid || elements.confirmRequiredPid.textContent;
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
    return true;
  } catch (err) {
    showToast(err.message, 'error');
    return false;
  }
}

async function updateSystemUsage() {
  try {
    const res = await fetch('/api/system/usage');
    if (!res.ok) return;
    const data = await res.json();
    
    // Update metric display
    if (elements.metricCpuUsage) {
      elements.metricCpuUsage.textContent = `${data.cpu}%`;
    }
    if (elements.metricCpuDetail) {
      elements.metricCpuDetail.textContent = getUsageLabel(data.cpu, 'CPU');
    }
    if (elements.cpuBar) {
      elements.cpuBar.style.width = `${data.cpu}%`;
      elements.cpuBar.style.backgroundColor = data.cpu > 80 ? '#ff4b4b' : data.cpu > 50 ? '#ffc107' : '#00e676';
    }
    
    if (elements.metricMemoryUsage) {
      const usedGb = (data.memory.usedBytes / (1024 ** 3)).toFixed(2);
      const totalGb = (data.memory.totalBytes / (1024 ** 3)).toFixed(2);
      elements.metricMemoryUsage.textContent = `${usedGb} מתוך ${totalGb} GB`;
    }
    if (elements.metricMemoryDetail) {
      elements.metricMemoryDetail.textContent = `${data.memory.percentage}% בשימוש — ${getUsageLabel(data.memory.percentage, 'זיכרון')}`;
    }
    
    if (elements.memoryBar) {
      elements.memoryBar.style.width = `${data.memory.percentage}%`;
      elements.memoryBar.style.backgroundColor = data.memory.percentage > 85 ? '#ff4b4b' : data.memory.percentage > 70 ? '#ffc107' : '#00e676';
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
    console.error('Failed to update system metrics:', err);
  }
}

async function updateStorageUsage() {
  elements.storageRefreshBtn.disabled = true;
  try {
    const res = await fetch('/api/system/storage');
    if (!res.ok) throw new Error('Storage unavailable');
    const { disk, cache } = await res.json();

    elements.metricDiskUsage.textContent = `${disk.percentage}% בשימוש`;
    elements.metricDiskDetail.textContent = `${formatBytes(disk.availableBytes)} פנויים מתוך ${formatBytes(disk.totalBytes)}`;
    elements.metricCacheUsage.textContent = formatBytes(cache.knownBytes);
    elements.metricCacheDetail.textContent = `${cache.scannedItems} תיקיות Cache קריאות — אין מחיקה אוטומטית`;
    elements.cacheFindings.replaceChildren();

    if (cache.items.length === 0) {
      elements.cacheFindings.textContent = 'לא נמצאו תיקיות Cache שניתן לקרוא.';
      return;
    }

    cache.items.forEach(item => {
      const finding = document.createElement('div');
      finding.className = 'storage-finding';
      const name = document.createElement('strong');
      name.textContent = item.name;
      const size = document.createElement('span');
      size.textContent = formatBytes(item.bytes);
      finding.append(name, size);
      elements.cacheFindings.appendChild(finding);
    });
  } catch (err) {
    console.warn('Failed to update storage metrics:', err);
    elements.cacheFindings.textContent = 'לא ניתן לסרוק Cache כרגע.';
  } finally {
    elements.storageRefreshBtn.disabled = false;
  }
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
          suspendSystemProcess(proc.pid);
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
      elements.quickCleanBtn.onclick = async () => {
        const confirmMessage = `האם אתה בטוח שברצונך לסגור את כל (${heavyProcs.length}) התהליכים הכבדים שזוהו?\n` + 
          heavyProcs.map(p => `- ${p.processName} (PID: ${p.pid})`).join('\n');
        if (confirm(confirmMessage)) {
          for (const proc of heavyProcs) {
            await executeKill(proc.pid, '-');
          }
          showToast('בוצעה אופטימיזציה מהירה לתהליכים הכבדים.', 'success');
          updateSystemUsage();
          if (activeFilter === 'system-resources') {
            fetchSystemProcesses();
          } else {
            fetchPorts();
          }
        }
      };
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
      body: JSON.stringify({ pid })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error?.message || 'שגיאה בהשהיית התהליך');
    showToast(`תהליך ${pid} מושהה בהצלחה`, 'success');
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
  if (!Number.isFinite(bytes)) return '—';
  return `${(bytes / (1024 ** 3)).toFixed(bytes >= 1024 ** 3 ? 1 : 2)} GB`;
}

function getProcessIcon(processName) {
  const name = (processName || '').toLowerCase();
  if (name.includes('node') || name.includes('npm')) return '🟢';
  if (name.includes('python')) return '🐍';
  if (name.includes('docker') || name.includes('dockerd')) return '🐳';
  if (name.includes('java')) return '☕';
  if (name.includes('postgres') || name.includes('pg')) return '🐘';
  if (name.includes('redis')) return '💾';
  if (name.includes('chrome') || name.includes('chromium')) return '🌐';
  if (name.includes('go') || name.includes('gopls')) return '🐹';
  if (name.includes('ruby')) return '💎';
  if (name.includes('port-manager') || name.includes('server.js')) return '🔌';
  return '⚙️';
}

function showToast(message, type = 'info') {
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

function renderSimpleSystemProcesses() {
  const tableView = document.getElementById('table-view-wrapper');
  const cardsView = document.getElementById('cards-view-wrapper');
  if (tableView) tableView.classList.add('hidden');
  if (cardsView) cardsView.classList.remove('hidden');

  const cardsContainer = document.getElementById('ports-cards-container');
  cardsContainer.innerHTML = '';
  
  if (filteredProcesses.length === 0) {
    elements.emptyState.classList.remove('hidden');
    return;
  }
  elements.emptyState.classList.add('hidden');
  
  // Update simple status strip
  const simpleSummaryText = document.getElementById('simple-summary-text');
  if (simpleSummaryText) {
    simpleSummaryText.textContent = `המחשב פועל בצורה תקינה. מציג ${filteredProcesses.length} תהליכי מערכת ומשאבים.`;
  }
  
  filteredProcesses.forEach(proc => {
    const card = document.createElement('div');
    card.className = 'port-card';
    const isReadOnlyMode = typeof window.SafetySettings !== 'undefined' && !window.SafetySettings.canKill();
    
    let actionButtonHtml = '';
    if (proc.isSystem) {
      actionButtonHtml = `<span class="port-card-protected-label">🔒 מוגן מערכת</span>`;
    } else {
      actionButtonHtml = `
        <button class="port-card-kill-btn btn-danger btn-kill-proc" ${isReadOnlyMode ? 'disabled' : ''} title="סגור תהליך במערכת">
          כבה תהליך
        </button>
      `;
    }
    
    const processIcon = getProcessIcon(proc.processName);
    
    card.innerHTML = `
      <div class="port-card-header">
        <span class="port-card-icon">${processIcon}</span>
        <div class="port-card-info">
          <strong class="port-card-title" dir="ltr">${escapeHtml(proc.processName)}</strong>
          <span class="port-card-desc">משתמש: ${escapeHtml(proc.user)}</span>
        </div>
      </div>
      <div class="port-card-body">
        <div class="port-card-ports-row">
          <span class="port-card-badge">PID ${proc.pid}</span>
        </div>
        <div class="port-card-safety-row">
          <span class="port-card-safety-badge ${proc.isSuspended ? 'exposed' : 'safe'}">
            סטטוס: ${proc.isSuspended ? 'מושהה' : 'פעיל'}
          </span>
        </div>
        <div style="font-weight: 600; color: var(--color-primary); margin-top: 0.25rem;">
          ${proc.cpu}% CPU · ${proc.memoryMb} MB RAM
        </div>
      </div>
      <div class="port-card-footer" style="justify-content: flex-end;">
        ${actionButtonHtml}
      </div>
    `;
    
    if (!proc.isSystem) {
      const killBtn = card.querySelector('.btn-kill-proc');
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
    
    cardsContainer.appendChild(card);
  });
}

function renderSimpleCards() {
  const tableView = document.getElementById('table-view-wrapper');
  const cardsView = document.getElementById('cards-view-wrapper');
  if (tableView) tableView.classList.add('hidden');
  if (cardsView) cardsView.classList.remove('hidden');

  const cardsContainer = document.getElementById('ports-cards-container');
  cardsContainer.innerHTML = '';

  if (filteredPorts.length === 0) {
    elements.emptyState.classList.remove('hidden');
    return;
  }
  elements.emptyState.classList.add('hidden');

  // Separate user and system ports
  const userPorts = filteredPorts.filter(p => !p.isSystem);
  const systemPorts = filteredPorts.filter(p => p.isSystem);

  // Update simple status strip
  const simpleSummaryText = document.getElementById('simple-summary-text');
  if (simpleSummaryText) {
    simpleSummaryText.textContent = `המחשב פועל בצורה תקינה. ישנן ${userPorts.length} אפליקציות משתמש פעילות כרגע.`;
  }

  // Helper to create card HTML
  function createCardElement(portObj) {
    const card = document.createElement('div');
    card.className = 'port-card';
    if (portObj.isSelf) {
      card.classList.add('self-card');
    }

    const portNumber = Number(portObj.port);
    const portText = (portObj.ports || [portObj.port]).join(', ');
    const pidText = (portObj.pids || [portObj.pid]).join(', ');
    const isSelf = portNumber === selfPort;
    const isSystemProcess = portObj.isSystem === true;
    const isReadOnlyMode = typeof window.SafetySettings !== 'undefined' && !window.SafetySettings.canKill();
    const isAggregate = portObj.isAggregate === true;
    const killDisabled = isAggregate || isSelf || isSystemProcess || isReadOnlyMode;

    const processIcon = getProcessIcon(portObj.processName);
    const appName = getFriendlyAppName(portObj);
    const sourceInfo = getSourceInfo(portObj);
    const listenerInfo = getListenerInfo(portObj);

    // Format folder path for simple view
    let folderDisplay = '';
    if (sourceInfo.path && sourceInfo.path !== 'לא זמין' && sourceInfo.path !== '/') {
      const parts = sourceInfo.path.split('/');
      const filename = parts.pop();
      const foldername = parts.pop() || '';
      folderDisplay = foldername ? `📁 ${foldername}/${filename}` : `📁 ${filename}`;
    }

    // Determine security status
    let safetyBadgeHtml = '';
    if (listenerInfo.label === 'מקומי בלבד') {
      safetyBadgeHtml = `<span class="port-card-safety-badge safe">🔒 רק במחשב שלי (מאובטח)</span>`;
    } else {
      safetyBadgeHtml = `<span class="port-card-safety-badge exposed">🌐 פתוח לרשת המקומית (ציבורי)</span>`;
    }

    // Check if HTTP to show "Open in Browser" button
    const isHttpPort = [80, 443, 3000, 5000, 5173, 8000, 8080, 9000].includes(portNumber);
    let openBrowserBtnHtml = '';
    if (isHttpPort && !isSystemProcess) {
      const protocol = portNumber === 443 ? 'https' : 'http';
      openBrowserBtnHtml = `
        <a href="${protocol}://localhost:${portNumber}" target="_blank" rel="noopener noreferrer" class="port-card-link-btn" title="פתח את האתר בדפנפדן">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"></path>
            <polyline points="15 3 21 3 21 9"></polyline>
            <line x1="10" y1="14" x2="21" y2="3"></line>
          </svg>
          פתח בדפדפן
        </a>
      `;
    }

    // Port description (friendly name)
    const portDesc = PORT_DESCRIPTIONS[portNumber] || (isSystemProcess ? 'שירות מערכת macOS' : 'תהליך ריצה');

    // Action button
    let actionBtnHtml = '';
    if (isSelf) {
      actionBtnHtml = `<span class="port-card-protected-label">🔌 מנהל הפורטים (פעיל)</span>`;
    } else if (isSystemProcess) {
      actionBtnHtml = `<span class="port-card-protected-label">🛡️ מוגן על ידי macOS</span>`;
    } else {
      actionBtnHtml = `
        <button class="port-card-kill-btn" ${killDisabled ? 'disabled' : ''} title="${killDisabled ? 'סגירה חסומה' : 'עצור פעילות אפליקציה'}">
          עצור אפליקציה
        </button>
      `;
    }

    card.innerHTML = `
      <div class="port-card-header">
        <span class="port-card-icon">${processIcon}</span>
        <div class="port-card-info">
          <strong class="port-card-title" dir="ltr">${escapeHtml(appName)}</strong>
          <span class="port-card-desc">${escapeHtml(portDesc)}</span>
          ${folderDisplay ? `<span class="port-card-directory" title="${escapeHtml(sourceInfo.path)}">${escapeHtml(folderDisplay)}</span>` : ''}
        </div>
      </div>
      <div class="port-card-body">
        <div class="port-card-ports-row">
          <span class="port-card-badge ${isSystemProcess ? 'system' : ''} ${isSelf ? 'self' : ''}">פורט ${portText}</span>
          ${openBrowserBtnHtml}
        </div>
        <div class="port-card-safety-row">
          ${safetyBadgeHtml}
        </div>
        <div class="port-card-pid">מזהה תהליך (PID): ${pidText}</div>
      </div>
      <div class="port-card-footer">
        <button class="port-card-details-link btn-details-action">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width: 14px; height: 14px;">
            <circle cx="12" cy="12" r="10"></circle>
            <line x1="12" y1="16" x2="12" y2="12"></line>
            <line x1="12" y1="8" x2="12.01" y2="8"></line>
          </svg>
          פרטים טכניים
        </button>
        ${actionBtnHtml}
      </div>
    `;

    // Bind event listeners
    card.querySelector('.btn-details-action').addEventListener('click', () => {
      openDetailsModal(portObj);
    });

    const killBtn = card.querySelector('.port-card-kill-btn');
    if (killBtn && !killDisabled) {
      killBtn.addEventListener('click', () => {
        openConfirmModal('kill', portObj);
      });
    }

    return card;
  }

  // Group user ports by category
  const categories = {
    dev: {
      id: 'category-dev',
      title: '💻 אתרים ושרתי פיתוח מקומיים',
      ports: [],
      defaultExpanded: true,
      sessionKey: 'accordion_dev_expanded'
    },
    db: {
      id: 'category-db',
      title: '🐘 מסדי נתונים ושירותי רקע',
      ports: [],
      defaultExpanded: false,
      sessionKey: 'accordion_db_expanded'
    },
    apps: {
      id: 'category-apps',
      title: '🌐 אפליקציות ודפדפנים',
      ports: [],
      defaultExpanded: false,
      sessionKey: 'accordion_apps_expanded'
    },
    other: {
      id: 'category-other',
      title: '⚙️ שירותים אחרים',
      ports: [],
      defaultExpanded: false,
      sessionKey: 'accordion_other_expanded'
    }
  };

  userPorts.forEach(portObj => {
    const name = (portObj.processName || '').toLowerCase();
    const cmd = (portObj.commandLine || '').toLowerCase();
    const portNumber = Number(portObj.port);
    const desc = PORT_DESCRIPTIONS[portNumber] || '';

    // 1. Check if DB
    const isDb = name.includes('postgres') || name.includes('pg') || name.includes('mysql') || 
                 name.includes('redis') || name.includes('mongo') || name.includes('elastic') || 
                 name.includes('sql') || name.includes('docker') || name.includes('dockerd') ||
                 [3306, 5432, 6379, 27017, 9200].includes(portNumber) ||
                 desc.includes('נתונים') || desc.includes('Redis');
                 
    // 2. Check if App/Browser
    const isApp = name.includes('chrome') || name.includes('chromium') || name.includes('firefox') || 
                  name.includes('safari') || name.includes('browser') || name.includes('slack') || 
                  name.includes('spotify') || name.includes('electron') || name.includes('discord') ||
                  cmd.includes('.app/contents/macos/');

    // 3. Check if Dev Server
    const isDev = name.includes('node') || name.includes('npm') || name.includes('python') || 
                  name.includes('vite') || name.includes('ruby') || name.includes('go') || 
                  name.includes('gopls') || name.includes('port-manager') || name.includes('server.js') ||
                  [80, 443, 3000, 5000, 5173, 7000, 8000, 8080, 9000].includes(portNumber) ||
                  desc.includes('פיתוח') || desc.includes('שרת');

    if (isDb) {
      categories.db.ports.push(portObj);
    } else if (isApp) {
      categories.apps.ports.push(portObj);
    } else if (isDev) {
      categories.dev.ports.push(portObj);
    } else {
      categories.other.ports.push(portObj);
    }
  });

  // Render cards based on active filter
  if (activeFilter === 'user') {
    renderUserCategories();
  } else if (activeFilter === 'system') {
    renderSystemCategory();
  } else {
    // 'all' filter: show user ports grouped, then system ports
    renderUserCategories();
    renderSystemCategory();
  }

  function renderUserCategories() {
    Object.values(categories).forEach(cat => {
      if (cat.ports.length === 0) return;

      const accordion = document.createElement('div');
      accordion.className = 'system-processes-accordion glass';
      accordion.style.marginBottom = '1rem';
      
      const sessionVal = sessionStorage.getItem(cat.sessionKey);
      const isExpanded = sessionVal !== null ? (sessionVal === 'true') : cat.defaultExpanded;

      accordion.innerHTML = `
        <div class="accordion-header" id="${cat.id}-toggle" role="button" aria-expanded="${isExpanded}" tabindex="0">
          <span>${cat.title} (${cat.ports.length} פעילים)</span>
          <svg class="accordion-arrow" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="transform: ${isExpanded ? 'rotate(180deg)' : 'rotate(0deg)'}">
            <polyline points="6 9 12 15 18 9"></polyline>
          </svg>
        </div>
        <div class="accordion-content ${isExpanded ? '' : 'hidden'}" id="${cat.id}-content">
          <div class="cards-grid" id="${cat.id}-grid">
            <!-- Cards go here -->
          </div>
        </div>
      `;

      cardsContainer.appendChild(accordion);

      const grid = accordion.querySelector(`#${cat.id}-grid`);
      cat.ports.forEach(port => {
        grid.appendChild(createCardElement(port));
      });

      const toggleBtn = accordion.querySelector(`#${cat.id}-toggle`);
      const content = accordion.querySelector(`#${cat.id}-content`);
      const arrow = accordion.querySelector('.accordion-arrow');

      toggleBtn.addEventListener('click', () => {
        const currentlyHidden = content.classList.contains('hidden');
        content.classList.toggle('hidden', !currentlyHidden);
        toggleBtn.setAttribute('aria-expanded', currentlyHidden);
        arrow.style.transform = currentlyHidden ? 'rotate(180deg)' : 'rotate(0deg)';
        sessionStorage.setItem(cat.sessionKey, currentlyHidden);
      });

      toggleBtn.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          toggleBtn.click();
        }
      });
    });
  }

  function renderSystemCategory() {
    if (systemPorts.length === 0) return;

    const accordion = document.createElement('div');
    accordion.className = 'system-processes-accordion glass';
    accordion.style.marginBottom = '1rem';
    
    // Default expanded only if activeFilter is exactly 'system'
    const defaultExp = activeFilter === 'system';
    const sessionKey = 'accordion_system_expanded';
    const sessionVal = sessionStorage.getItem(sessionKey);
    const isExpanded = sessionVal !== null ? (sessionVal === 'true') : defaultExp;

    accordion.innerHTML = `
      <div class="accordion-header" id="system-accordion-toggle" role="button" aria-expanded="${isExpanded}" tabindex="0">
        <span>⚙️ תהליכי מערכת של macOS (עוד ${systemPorts.length} תהליכים מוגנים)</span>
        <svg class="accordion-arrow" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="transform: ${isExpanded ? 'rotate(180deg)' : 'rotate(0deg)'}">
          <polyline points="6 9 12 15 18 9"></polyline>
        </svg>
      </div>
      <div class="accordion-content ${isExpanded ? '' : 'hidden'}" id="system-accordion-content">
        <div class="cards-grid" id="system-accordion-grid">
          <!-- System cards go here -->
        </div>
      </div>
    `;

    cardsContainer.appendChild(accordion);

    const systemGrid = accordion.querySelector('#system-accordion-grid');
    systemPorts.forEach(port => {
      systemGrid.appendChild(createCardElement(port));
    });

    const toggleBtn = accordion.querySelector('#system-accordion-toggle');
    const content = accordion.querySelector('#system-accordion-content');
    const arrow = accordion.querySelector('.accordion-arrow');

    toggleBtn.addEventListener('click', () => {
      const currentlyHidden = content.classList.contains('hidden');
      content.classList.toggle('hidden', !currentlyHidden);
      toggleBtn.setAttribute('aria-expanded', currentlyHidden);
      arrow.style.transform = currentlyHidden ? 'rotate(180deg)' : 'rotate(0deg)';
      sessionStorage.setItem(sessionKey, currentlyHidden);
    });

    toggleBtn.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        toggleBtn.click();
      }
    });
  }
}
