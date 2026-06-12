/**
 * settings.js — Safety Settings Panel module
 *
 * Manages the safety configuration panel UI:
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
      if (!res.ok) throw new Error('Safety API unavailable');
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
      if (!res.ok) throw new Error(data.error?.message || 'Failed to set mode');
      await fetchSafetyStatus();
      renderAll();
      showToast(`Safety mode changed to ${mode}`, 'info');
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
      if (!res.ok) throw new Error(data.error?.message || `Failed to ${action} port ${port}`);
      await fetchSafetyStatus();
      renderAllowlist();
      showToast(`Port ${port} ${action === 'add' ? 'added to' : 'removed from'} allowlist`, 'success');
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
      if (!res.ok) throw new Error(data.error?.message || `Failed to ${action} port ${port}`);
      await fetchSafetyStatus();
      renderBlocklist();
      showToast(`Port ${port} ${action === 'add' ? 'added to' : 'removed from'} blocklist`, action === 'add' ? 'warning' : 'success');
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
      els.modeLabel.textContent = 'No safety data';
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
      'read-only': { icon: '👁️', label: 'Read-Only', cls: 'badge-readonly' },
      'allowlist': { icon: '✅', label: 'Allowlist', cls: 'badge-allowlist' },
      'blocklist': { icon: '🚫', label: 'Blocklist', cls: 'badge-blocklist' },
    };
    const ml = modeLabels[mode] || modeLabels['read-only'];
    els.modeStatusBadge.textContent = ml.icon + ' ' + ml.label;
    els.modeStatusBadge.className = 'badge badge-mode ' + ml.cls;
    els.modeLabel.textContent = 'Mode: ' + ml.label;

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
      els.allowlistList.innerHTML = '<li class="list-empty">No data</li>';
      els.allowlistCount.textContent = '0';
      return;
    }
    const ports = safetyState.allowlist || [];
    els.allowlistCount.textContent = ports.length;
    if (ports.length === 0) {
      els.allowlistList.innerHTML = '<li class="list-empty">No ports in allowlist</li>';
      return;
    }
    els.allowlistList.innerHTML = ports.map(function (p) {
      return '<li class="port-list-item allowlist-item">' +
        '<span class="port-num">' + p + '</span>' +
        '<button class="btn-list-remove" data-action="remove-allowlist" data-port="' + p + '" aria-label="Remove port ' + p + ' from allowlist">&times;</button>' +
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
      els.blocklistList.innerHTML = '<li class="list-empty">No data</li>';
      els.blocklistCount.textContent = '0';
      return;
    }
    const ports = safetyState.blocklist || [];
    els.blocklistCount.textContent = ports.length;
    if (ports.length === 0) {
      els.blocklistList.innerHTML = '<li class="list-empty">No ports in blocklist</li>';
      return;
    }
    els.blocklistList.innerHTML = ports.map(function (p) {
      return '<li class="port-list-item blocklist-item">' +
        '<span class="port-num">' + p + '</span>' +
        '<span class="port-type-badge system-badge">system</span>' +
        '<button class="btn-list-remove" data-action="remove-blocklist" data-port="' + p + '" aria-label="Remove port ' + p + ' from blocklist">&times;</button>' +
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

    els.statusMode.textContent = safetyState.mode || '—';
    els.statusAllowlist.textContent = (safetyState.allowlist || []).length + ' ports';
    els.statusBlocklist.textContent = (safetyState.blocklist || []).length + ' ports';
    els.statusUser.textContent = safetyState.currentUser || '—';
    els.statusRateLimit.textContent = (safetyState.maxOpsPerMinute || '—') + ' / min';
    els.statusCooldown.textContent = ((safetyState.cooldownMs || 0) / 1000) + 's';
  }

  function updateHeaderBadge() {
    if (!els.headerSafetyBadge) return;
    if (!safetyState) {
      els.headerSafetyBadge.textContent = '🔒';
      els.headerSafetyBadge.title = 'Safety status unavailable';
      return;
    }
    const mode = safetyState.mode || 'read-only';
    const icons = {
      'read-only': '👁️',
      'allowlist': '✅',
      'blocklist': '🚫',
    };
    els.headerSafetyBadge.textContent = icons[mode] || '🔒';
    els.headerSafetyBadge.title = 'Safety mode: ' + mode + (mode === 'read-only' ? ' — no destructive actions allowed' : '');
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
      showToast('Invalid port: must be 1–65535', 'error');
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
      showToast('Invalid port: must be 1–65535', 'error');
      return;
    }
    // Warn before adding to blocklist
    if (!confirm('Adding port ' + port + ' to blocklist will prevent destructive operations on it. Are you sure?')) {
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
    // Use global showToast from app.js if available
    if (typeof window.showToast === 'function') {
      window.showToast(message, type);
      return;
    }
    // Fallback: simple console
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
