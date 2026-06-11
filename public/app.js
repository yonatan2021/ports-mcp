// App State
let portsData = [];
let filteredPorts = [];
let activeFilter = 'all'; // 'all', 'user', 'system'
let searchQuery = '';
let currentSort = { column: 'port', order: 'asc' };
let pollIntervalId = null;
const POLL_INTERVAL = 8000; // 8 seconds

// Self Port detection based on the loaded URL
const selfPort = parseInt(window.location.port, 10) || 9999;

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

  // Confirm Modal
  confirmModal: document.getElementById('confirm-modal'),
  modalTitle: document.getElementById('modal-title'),
  modalDesc: document.getElementById('modal-desc'),
  modalConfirmBtn: document.getElementById('modal-confirm-btn'),
  modalCancelBtn: document.getElementById('modal-cancel-btn'),
  modalCloseBtn: document.getElementById('modal-close-btn'),
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
  specProtocol: document.getElementById('spec-protocol'),
  specType: document.getElementById('spec-type'),
  specCommand: document.getElementById('spec-command')
};

// --- INITIALIZATION ---
document.addEventListener('DOMContentLoaded', () => {
  setupEventListeners();
  fetchPorts();
  startPolling();
});

function setupEventListeners() {
  // Refresh button
  elements.refreshBtn.addEventListener('click', () => {
    fetchPorts();
  });

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
      applyFilters();
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
    startPolling();
  };
  elements.modalCancelBtn.addEventListener('click', closeConfirmModal);
  elements.modalCloseBtn.addEventListener('click', closeConfirmModal);
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

// --- DATA FETCHING ---
async function fetchPorts() {
  // Show loading spinner
  elements.tableBody.innerHTML = `
    <tr>
      <td colspan="7" class="loading-state">
        <div class="spinner"></div>
        Scanning macOS ports...
      </td>
    </tr>
  `;
  elements.emptyState.classList.add('hidden');
  
  try {
    const response = await fetch('/api/ports');
    if (!response.ok) throw new Error('API server returned an error');
    const data = await response.json();
    portsData = data.ports || [];
    applyFilters();
  } catch (err) {
    console.error(err);
    elements.tableBody.innerHTML = `
      <tr>
        <td colspan="7" class="loading-state" style="color: var(--color-danger)">
          ⚠️ Failed to connect to the Port Manager service.
        </td>
      </tr>
    `;
    showToast('Failed to connect to backend service', 'error');
  }
}

// Silent refresh in the background (no full loading state)
async function fetchPortsSilent() {
  // Do not poll if a modal is visible
  if (!elements.confirmModal.classList.contains('hidden') || !elements.detailsModal.classList.contains('hidden')) {
    return;
  }

  try {
    const response = await fetch('/api/ports');
    if (!response.ok) throw new Error('Silent fetch failed');
    const data = await response.json();
    portsData = data.ports || [];
    applyFilters();
  } catch (err) {
    console.warn('Silent refresh failed:', err);
  }
}

// --- FILTERING & SORTING ---
function applyFilters() {
  filteredPorts = portsData.filter(portObj => {
    // 1. Tab filter
    if (activeFilter === 'system' && portObj.port > 1024) return false;
    if (activeFilter === 'user' && portObj.port <= 1024) return false;

    // 2. Search query filter
    if (searchQuery) {
      const portStr = String(portObj.port);
      const pidStr = String(portObj.pid);
      const name = (portObj.processName || '').toLowerCase();
      const cmd = (portObj.commandLine || '').toLowerCase();
      const user = (portObj.user || '').toLowerCase();
      
      const match = portStr.includes(searchQuery) ||
                    pidStr.includes(searchQuery) ||
                    name.includes(searchQuery) ||
                    cmd.includes(searchQuery) ||
                    user.includes(searchQuery);
      if (!match) return false;
    }

    return true;
  });

  updateMetrics();
  sortAndRender();
}

function updateMetrics() {
  const activeCount = portsData.length;
  const userCount = portsData.filter(p => p.port > 1024).length;
  const systemCount = portsData.filter(p => p.port <= 1024).length;

  elements.metricActiveCount.textContent = activeCount;
  elements.metricUserCount.textContent = userCount;
  elements.metricSystemCount.textContent = systemCount;
}

function sortAndRender() {
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

// --- RENDERING ---
function renderTable() {
  elements.tableBody.innerHTML = '';

  if (filteredPorts.length === 0) {
    elements.emptyState.classList.remove('hidden');
    return;
  }

  elements.emptyState.classList.add('hidden');

  filteredPorts.forEach(portObj => {
    const tr = document.createElement('tr');
    const isSelf = portObj.port === selfPort;

    // Port Badge Class
    let badgeClass = 'port-badge';
    if (isSelf) {
      badgeClass += ' self';
    } else if (portObj.port <= 1024) {
      badgeClass += ' system';
    }

    // Command display truncation
    const cmdClean = (portObj.commandLine || '').replace(/\n/g, ' ');
    const processIcon = getProcessIcon(portObj.processName);

    tr.innerHTML = `
      <td>
        <span class="${badgeClass}">${portObj.port}</span>
      </td>
      <td>
        <div class="process-name-cell">
          <span class="process-icon">${processIcon}</span>
          <span class="process-title">${escapeHtml(portObj.processName)}</span>
        </div>
      </td>
      <td class="font-mono">${portObj.pid}</td>
      <td>${escapeHtml(portObj.user)}</td>
      <td>
        <span class="protocol-badge ${portObj.protocol.toLowerCase()}">${portObj.protocol} (${portObj.type})</span>
      </td>
      <td class="command-cell" title="${escapeHtml(cmdClean)}">
        ${escapeHtml(cmdClean)}
      </td>
      <td class="text-right">
        <div class="action-group">
          <button class="action-btn btn-details-action" title="View details and full command">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <circle cx="12" cy="12" r="10"></circle>
              <line x1="12" y1="16" x2="12" y2="12"></line>
              <line x1="12" y1="8" x2="12.01" y2="8"></line>
            </svg>
          </button>
          <button class="action-btn btn-restart-action" disabled title="Restart is disabled until an explicit allowlist exists">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M21.5 2v6h-6M21.34 15.57a10 10 0 1 1-.57-8.38l5.67-5.67"/>
            </svg>
          </button>
          <button class="action-btn btn-kill-action" ${isSelf ? 'disabled' : ''} title="Kill process on port ${portObj.port}">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M18.36 6.64a9 9 0 1 1-12.73 0"></path>
              <line x1="12" y1="2" x2="12" y2="12"></line>
            </svg>
          </button>
        </div>
      </td>
    `;

    // Hook buttons up
    tr.querySelector('.btn-details-action').addEventListener('click', () => {
      openDetailsModal(portObj);
    });

    if (!isSelf) {
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
  elements.previewPort.textContent = portObj.port;
  elements.previewProcess.textContent = portObj.processName;
  elements.previewPid.textContent = portObj.pid;
  elements.previewCommand.textContent = portObj.commandLine;

  if (action === 'kill') {
    elements.modalTitle.textContent = 'Terminate Process';
    elements.modalDesc.textContent = `Are you sure you want to kill the following process? This will close the connection and free up port ${portObj.port}.`;
    elements.modalConfirmBtn.textContent = 'Terminate Process';
    elements.modalConfirmBtn.className = 'btn btn-danger';
    
    // Set confirmation button callback
    elements.modalConfirmBtn.onclick = async () => {
      elements.modalConfirmBtn.disabled = true;
      elements.modalConfirmBtn.textContent = 'Killing...';
      
      const success = await executeKill(portObj.pid, portObj.port);
      elements.modalConfirmBtn.disabled = false;
      elements.confirmModal.classList.add('hidden');
      
      if (success) {
        fetchPorts();
      } else {
        startPolling();
      }
    };
  } else if (action === 'restart') {
    elements.modalTitle.textContent = 'Restart Port Process';
    elements.modalDesc.textContent = `This will terminate the active process and attempt to re-run the original command on port ${portObj.port}.`;
    elements.modalConfirmBtn.textContent = 'Restart Process';
    elements.modalConfirmBtn.className = 'btn btn-primary';
    
    elements.modalConfirmBtn.onclick = async () => {
      elements.modalConfirmBtn.disabled = true;
      elements.modalConfirmBtn.textContent = 'Restarting...';
      
      const success = await executeRestart(portObj.pid, portObj.port, portObj.commandLine);
      elements.modalConfirmBtn.disabled = false;
      elements.confirmModal.classList.add('hidden');
      
      if (success) {
        // Wait 1.5s for process to start before scanner reads again
        setTimeout(fetchPorts, 1500);
      } else {
        startPolling();
      }
    };
  }

  elements.confirmModal.classList.remove('hidden');
}

function openDetailsModal(portObj) {
  stopPolling();

  elements.specPort.textContent = portObj.port;
  elements.specName.textContent = portObj.processName;
  elements.specPid.textContent = portObj.pid;
  elements.specUser.textContent = portObj.user;
  elements.specProtocol.textContent = portObj.protocol;
  elements.specType.textContent = portObj.type;
  elements.specCommand.textContent = portObj.commandLine;

  elements.btnCopyCommand.onclick = () => {
    navigator.clipboard.writeText(portObj.commandLine)
      .then(() => {
        const originalText = elements.btnCopyCommand.innerHTML;
        elements.btnCopyCommand.innerHTML = 'Copied!';
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
        showToast('Failed to copy to clipboard', 'error');
      });
  };

  elements.detailsModal.classList.remove('hidden');
}

// --- CALL TO BACKEND APIs ---
async function executeKill(pid, port) {
  try {
    const res = await fetch('/api/ports/kill', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pid, port, confirm: true })
    });
    
    const data = await res.json();
    if (!res.ok) throw new Error(data.error?.message || data.error || 'Server error while terminating process');
    
    showToast(`Successfully terminated PID ${pid} on port ${port}`, 'success');
    return true;
  } catch (err) {
    showToast(err.message, 'error');
    return false;
  }
}

async function executeRestart() {
  showToast('Restart is disabled until an explicit safe command allowlist exists', 'error');
  return false;
}

// --- UTILITIES ---
function escapeHtml(str) {
  if (!str) return '';
  return str.replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#039;');
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

  // Auto-dismiss
  setTimeout(dismiss, 5000);
}
