/**
 * settings.js — Safety Settings Panel module
 *
 * Manages the safety configuration panel UI in Hebrew:
 * - Permission mode selector (read-only / allowlist / blocklist)
 * - Allowlist manager (add/remove ports)
 * - Blocklist manager (add/remove ports with warnings)
 * - Status display (current mode, active ports, protected count)
 *
 * Integrates with the backend safety API (/api/safety/*)
 * and communicates with app.js via a small event bridge.
 */

(function () {
  'use strict';

  // ─── State ─────────────────────────────────────────────────
  let safetyState = null;       // cached from GET /api/safety
  let refreshTimerId = null;
  const REFRESH_INTERVAL = 10000; // 10 seconds

  // Mode translations dictionary
  const modeTranslations = {
    'read-only': 'קריאה בלבד',
    'allowlist': 'רשימה מותרת',
    'blocklist': 'רשימה חסומה',
  };

  // ─── DOM Cache ─────────────────────────────────────────────
  let els = {};

  function cacheElements() {
    els = {
      // Panel toggles
      panel: document.getElementById('settings-panel'),
      settingsBtn: document.getElementById('settings-btn'),
      settingsCloseBtn: document.getElementById('settings-close-btn'),
      settingsOverlay: document.getElementById('settings-overlay'),

      // Mode selector
      modeRadios: document.querySelectorAll('input[name="safety-mode"]'),
      modeReadonly: document.getElementById('mode-readonly'),
      modeAllowlist: document.getElementById('mode-allowlist'),
      modeBlocklist: document.getElementById('mode-blocklist'),
      modeStatusBadge: document.getElementById('mode-status-badge'),
      modeLabel: document.getElementById('mode-label'),

      // Allowlist
      allowlistSection: document.getElementById('allowlist-section'),
      allowlistInput: document.getElementById('allowlist-input'),
      allowlistAddBtn: document.getElementById('allowlist-add-btn'),
      allowlistList: document.getElementById('allowlist-list'),
      allowlistCount: document.getElementById('allowlist-count'),

      // Blocklist
      blocklistSection: document.getElementById('blocklist-section'),
      blocklistInput: document.getElementById('blocklist-input'),
      blocklistAddBtn: document.getElementById('blocklist-add-btn'),
      blocklistList: document.getElementById('blocklist-list'),
      blocklistCount: document.getElementById('blocklist-count'),

      // Status
      statusMode: document.getElementById('settings-status-mode'),
      statusAllowlist: document.getElementById('settings-status-allowlist'),
      statusBlocklist: document.getElementById('settings-status-blocklist'),
      statusUser: document.getElementById('settings-status-user'),
      statusRateLimit: document.getElementById('settings-status-rate-limit'),
      statusCooldown: document.getElementById('settings-status-cooldown'),

      // Header indicator
      headerSafetyBadge: document.getElementById('header-safety-badge'),
    };
  }

  // ─── API Calls ─────────────────────────────────────────────

  async function fetchSafetyStatus() {
    try {
      const res = await fetch('/api/safety');
      if (!res.ok) throw new Error('שירות הגדרות האבטחה אינו זמין');
      const data = await res.json();
      safetyState = data.safety;
      return safetyState;
    } catch (err) {
      console.warn('[settings] Failed to fetch safety status:', err.message);
      safetyState = null;
      return null;
    }
  }

  async function setMode(mode) {
    try {
      const res = await fetch('/api/safety/mode', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error?.message || 'שינוי המצב נכשל');
      await fetchSafetyStatus();
      renderAll();
      showToast(`מצב אבטחה שונה ל-"${modeTranslations[mode] || mode}"`, 'info');
      
      // Request standard list refresh since button states will change
      if (typeof window.fetchPorts === 'function') {
        window.fetchPorts();
      } else if (typeof window.applyFilters === 'function') {
        window.applyFilters();
      }
      return true;
    } catch (err) {
      showToast(err.message, 'error');
      return false;
    }
  }

  async function manageAllowlist(action, port) {
    try {
      const res = await fetch('/api/safety/allowlist', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action, port }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error?.message || `פעולה נכשלה עבור פורט ${port}`);
      await fetchSafetyStatus();
      renderAllowlist();
      showToast(`פורט ${port} ${action === 'add' ? 'נוסף ל' : 'הוסר מ'}רשימת הפורטים המותרים`, 'success');
      
      // Update main table badges
      if (typeof window.applyFilters === 'function') {
        window.applyFilters();
      }
      return true;
    } catch (err) {
      showToast(err.message, 'error');
      return false;
    }
  }

  async function manageBlocklist(action, port) {
    try {
      const res = await fetch('/api/safety/blocklist', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action, port }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error?.message || `פעולה נכשלה עבור פורט ${port}`);
      await fetchSafetyStatus();
      renderBlocklist();
      showToast(`פורט ${port} ${action === 'add' ? 'נוסף ל' : 'הוסר מ'}רשימת הפורטים החסומים`, action === 'add' ? 'warning' : 'success');
      
      // Update main table badges
      if (typeof window.applyFilters === 'function') {
        window.applyFilters();
      }
      return true;
    } catch (err) {
      showToast(err.message, 'error');
      return false;
    }
  }

  // ─── Rendering ─────────────────────────────────────────────

  function renderAll() {
    if (!safetyState) {
      els.modeStatusBadge.textContent = '—';
      els.modeLabel.textContent = 'אין נתוני אבטחה';
      renderAllowlist();
      renderBlocklist();
      renderStatus();
      updateHeaderBadge();
      return;
    }

    // Mode selector active state
    const mode = safetyState.mode || 'read-only';
    els.modeRadios.forEach(function (radio) {
      radio.checked = radio.value === mode;
    });

    // Update badge + label
    const modeLabels = {
      'read-only': { icon: '👁️', label: 'קריאה בלבד', cls: 'badge-readonly' },
      'allowlist': { icon: '✅', label: 'רשימה מותרת', cls: 'badge-allowlist' },
      'blocklist': { icon: '🚫', label: 'רשימה חסומה', cls: 'badge-blocklist' },
    };
    const ml = modeLabels[mode] || modeLabels['read-only'];
    els.modeStatusBadge.textContent = ml.icon + ' ' + ml.label;
    els.modeStatusBadge.className = 'badge badge-mode ' + ml.cls;
    els.modeLabel.textContent = 'מצב פעיל: ' + ml.label;

    // Show/hide sections based on mode
    els.allowlistSection.classList.toggle('hidden', mode !== 'allowlist');
    els.blocklistSection.classList.toggle('hidden', mode !== 'blocklist');

    renderAllowlist();
    renderBlocklist();
    renderStatus();
    updateHeaderBadge();
  }

  function renderAllowlist() {
    if (!safetyState) {
      els.allowlistList.innerHTML = '<li class="list-empty">אין נתונים</li>';
      els.allowlistCount.textContent = '0';
      return;
    }
    const ports = safetyState.allowlist || [];
    els.allowlistCount.textContent = ports.length;
    if (ports.length === 0) {
      els.allowlistList.innerHTML = '<li class="list-empty">אין פורטים ברשימה המותרת</li>';
      return;
    }
    els.allowlistList.innerHTML = ports.map(function (p) {
      return '<li class="port-list-item allowlist-item">' +
        '<span class="port-num font-mono">' + p + '</span>' +
        '<button class="btn-list-remove" data-action="remove-allowlist" data-port="' + p + '" aria-label="הסר פורט ' + p + ' מהרשימה המותרת">&times;</button>' +
        '</li>';
    }).join('');

    // Wire remove buttons
    els.allowlistList.querySelectorAll('[data-action="remove-allowlist"]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        manageAllowlist('remove', Number(btn.dataset.port));
      });
    });
  }

  function renderBlocklist() {
    if (!safetyState) {
      els.blocklistList.innerHTML = '<li class="list-empty">אין נתונים</li>';
      els.blocklistCount.textContent = '0';
      return;
    }
    const ports = safetyState.blocklist || [];
    els.blocklistCount.textContent = ports.length;
    if (ports.length === 0) {
      els.blocklistList.innerHTML = '<li class="list-empty">אין פורטים ברשימה החסומה</li>';
      return;
    }
    els.blocklistList.innerHTML = ports.map(function (p) {
      const isSystem = Number(p) <= 1024;
      const tag = isSystem ? '<span class="port-type-badge system-badge">מערכת</span>' : '<span class="port-type-badge user-badge">משתמש</span>';
      return '<li class="port-list-item blocklist-item">' +
        '<span class="port-num font-mono">' + p + '</span>' +
        tag +
        '<button class="btn-list-remove" data-action="remove-blocklist" data-port="' + p + '" aria-label="הסר פורט ' + p + ' מהרשימה החסומה">&times;</button>' +
        '</li>';
    }).join('');

    els.blocklistList.querySelectorAll('[data-action="remove-blocklist"]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        manageBlocklist('remove', Number(btn.dataset.port));
      });
    });
  }

  function renderStatus() {
    if (!safetyState) {
      els.statusMode.textContent = '—';
      els.statusAllowlist.textContent = '—';
      els.statusBlocklist.textContent = '—';
      els.statusUser.textContent = '—';
      els.statusRateLimit.textContent = '—';
      els.statusCooldown.textContent = '—';
      return;
    }

    els.statusMode.textContent = modeTranslations[safetyState.mode] || safetyState.mode || '—';
    els.statusAllowlist.textContent = (safetyState.allowlist || []).length + ' פורטים';
    els.statusBlocklist.textContent = (safetyState.blocklist || []).length + ' פורטים';
    els.statusUser.textContent = safetyState.currentUser || '—';
    els.statusRateLimit.textContent = (safetyState.maxOpsPerMinute || '—') + ' לדקה';
    els.statusCooldown.textContent = ((safetyState.cooldownMs || 0) / 1000) + ' שנ\'';
  }

  function updateHeaderBadge() {
    if (!els.headerSafetyBadge) return;
    if (!safetyState) {
      // Show locked icon with red color
      els.headerSafetyBadge.innerHTML = `
        <svg viewBox="0 0 24 24" fill="none" stroke="var(--color-danger)" stroke-width="2" style="width:16px;height:16px;">
          <rect x="3" y="11" width="18" height="11" rx="2" ry="2"></rect>
          <path d="M7 11V7a5 5 0 0 1 10 0v4"></path>
        </svg>
      `;
      els.headerSafetyBadge.title = 'מצב הגנה אינו זמין';
      return;
    }
    const mode = safetyState.mode || 'read-only';
    
    // Choose lock SVG depending on mode
    let badgeColor = 'var(--text-secondary)';
    let isLocked = true;
    if (mode === 'read-only') {
      badgeColor = 'var(--color-info)';
      isLocked = true;
    } else if (mode === 'allowlist') {
      badgeColor = 'var(--color-success)';
      isLocked = false;
    } else if (mode === 'blocklist') {
      badgeColor = 'var(--color-warning)';
      isLocked = false;
    }

    if (isLocked) {
      els.headerSafetyBadge.innerHTML = `
        <svg viewBox="0 0 24 24" fill="none" stroke="${badgeColor}" stroke-width="2" style="width:16px;height:16px;">
          <rect x="3" y="11" width="18" height="11" rx="2" ry="2"></rect>
          <path d="M7 11V7a5 5 0 0 1 10 0v4"></path>
        </svg>
      `;
    } else {
      els.headerSafetyBadge.innerHTML = `
        <svg viewBox="0 0 24 24" fill="none" stroke="${badgeColor}" stroke-width="2" style="width:16px;height:16px;">
          <rect x="3" y="11" width="18" height="11" rx="2" ry="2"></rect>
          <path d="M7 11V7a5 5 0 0 1 9.9-1"></path>
        </svg>
      `;
    }

    els.headerSafetyBadge.title = 'מצב הגנה: ' + (modeTranslations[mode] || mode) + (mode === 'read-only' ? ' — כל פעולות הסגירה חסומות' : ' — מותר לבצע פעולות בכפוף לאבטחה');
  }

  // ─── Event Handlers ────────────────────────────────────────

  function togglePanel() {
    const isOpen = !els.panel.classList.contains('open');
    els.panel.classList.toggle('open', isOpen);
    els.settingsOverlay.classList.toggle('hidden', !isOpen);
    document.body.classList.toggle('settings-open', isOpen);
    if (isOpen) {
      refreshSafety();
    }
  }

  function closePanel() {
    els.panel.classList.remove('open');
    els.settingsOverlay.classList.add('hidden');
    document.body.classList.remove('settings-open');
  }

  function onModeChange(e) {
    const mode = e.target.value;
    if (!mode) return;
    if (safetyState && safetyState.mode === mode) return; // already set
    setMode(mode);
  }

  function onAllowlistAdd() {
    const val = els.allowlistInput.value.trim();
    if (!val) return;
    const port = Number(val);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      showToast('שגיאה: פורט חייב להיות מספר שלם בין 1 ל-65535', 'error');
      return;
    }
    manageAllowlist('add', port);
    els.allowlistInput.value = '';
  }

  function onBlocklistAdd() {
    const val = els.blocklistInput.value.trim();
    if (!val) return;
    const port = Number(val);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      showToast('שגיאה: פורט חייב להיות מספר שלם בין 1 ל-65535', 'error');
      return;
    }
    // Warn before adding to blocklist in Hebrew
    if (!confirm('הוספת פורט ' + port + ' לרשימה החסומה תמנע לחלוטין אפשרות לסגור את השירות הרץ עליו. האם להמשיך?')) {
      return;
    }
    manageBlocklist('add', port);
    els.blocklistInput.value = '';
  }

  function onKeydown(e) {
    if (e.key === 'Escape') {
      closePanel();
    }
  }

  // ─── Refresh Loop ──────────────────────────────────────────

  async function refreshSafety() {
    await fetchSafetyStatus();
    renderAll();
  }

  function startRefreshLoop() {
    stopRefreshLoop();
    refreshTimerId = setInterval(refreshSafety, REFRESH_INTERVAL);
  }

  function stopRefreshLoop() {
    if (refreshTimerId) {
      clearInterval(refreshTimerId);
      refreshTimerId = null;
    }
  }

  // ─── Toast (compatible with app.js showToast) ──────────────

  function showToast(message, type) {
    if (typeof window.showToast === 'function') {
      window.showToast(message, type);
      return;
    }
    console.log('[' + type + '] ' + message);
  }

  // ─── Public API for app.js integration ─────────────────────

  window.SafetySettings = {
    /** Open the settings panel */
    open: function () {
      togglePanel();
    },
    /** Close the settings panel */
    close: closePanel,
    /** Force a safety status refresh */
    refresh: refreshSafety,
    /** Get current safety state snapshot */
    getState: function () { return safetyState; },
    /** Check if destructive operations are allowed */
    canKill: function () {
      if (!safetyState) return true; // default allow if unknown
      return safetyState.mode !== 'read-only';
    },
    /** Check if a specific port is allowed for kill */
    isPortAllowed: function (port) {
      if (!safetyState) return true;
      const n = Number(port);
      if (!Number.isInteger(n)) return true;
      if (safetyState.mode === 'allowlist') {
        return (safetyState.allowlist || []).includes(n);
      }
      if (safetyState.mode === 'blocklist') {
        return !(safetyState.blocklist || []).includes(n);
      }
      return true; // read-only checked separately
    },
  };

  // ─── Init ──────────────────────────────────────────────────

  document.addEventListener('DOMContentLoaded', function () {
    cacheElements();
    if (!els.panel) return; // no settings panel in DOM

    // Toggle
    els.settingsBtn.addEventListener('click', togglePanel);
    els.settingsCloseBtn.addEventListener('click', closePanel);
    els.settingsOverlay.addEventListener('click', function (e) {
      if (e.target === els.settingsOverlay) closePanel();
    });
    document.addEventListener('keydown', onKeydown);

    // Mode selector
    els.modeRadios.forEach(function (radio) {
      radio.addEventListener('change', onModeChange);
    });

    // Allowlist
    els.allowlistAddBtn.addEventListener('click', onAllowlistAdd);
    els.allowlistInput.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') onAllowlistAdd();
    });

    // Blocklist
    els.blocklistAddBtn.addEventListener('click', onBlocklistAdd);
    els.blocklistInput.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') onBlocklistAdd();
    });

    // Initial fetch
    refreshSafety();
    startRefreshLoop();
  });
})();
