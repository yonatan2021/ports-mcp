/**
 * config.js — Safety configuration module for ports-mcp
 *
 * Loads from env vars with safe defaults.
 * Supports runtime updates via MCP tools (settable per session).
 * All config stored locally only — no data leaves the machine.
 */

const CRITICAL_PROCESS_NAMES = [
  // macOS kernel & system
  'launchd', 'kernel_task', 'kernel', 'init',
  'syslogd', 'notifyd', 'configd', 'UserEventAgent',
  'windowserver', 'WindowServer', 'corespeechd', 'apsd',
  'assistived', 'bluetoothd', 'cfprefsd', 'cloudd',
  'commcenter', 'coreaudiod', 'diskarbitrationd', 'distnoted',
  'dynamic_pager', 'fseventsd', 'hidd', 'iconservicesagent',
  'identityservicesd', 'locationd', 'logd',
  'mds', 'mdworker', 'mds_stores',
  'networkd', 'nsurlsessiond', 'opendirectoryd',
  'powerd', 'rapportd',
  'sandboxd', 'securityd', 'sharingd',
  'softwareupdate', 'spotlight', 'spotlightknowledged',
  'storeaccountd', 'storeassetd', 'storedownloadd', 'storekitd',
  'sysmond', 'system_installd', 'systemstats',
  'taskgated', 'timed', 'trustd',
  'usbd', 'watchdogd',
  'xartstored', 'xpcproxy',
  // Linux systemd
  'systemd', 'systemd-journald', 'systemd-logind', 'systemd-udevd',
  'systemd-resolved', 'systemd-timesyncd',
  // Common daemons (cross-platform)
  'cron', 'rsyslogd', 'sshd', 'ntpd', 'dbus-daemon',
  'polkitd', 'accounts-daemon', 'upowerd',
  'colord', 'cupsd', 'avahi-daemon',
];

/**
 * Known system ports (0–1023) that should be protected by default.
 */
function getSystemPortRange() {
  const ports = [];
  for (let i = 0; i < 1024; i++) ports.push(i);
  return ports;
}

const DEFAULTS = {
  /** Permission mode: 'read-only' | 'allowlist' | 'blocklist' */
  mode: 'blocklist',
  /** Port numbers that are allowed for destructive operations (allowlist mode) */
  allowlist: [],
  /** Port numbers that are blocked for destructive operations (blocklist mode) */
  blocklist: getSystemPortRange(),
  /** Process names that are always blocked from killing */
  processBlocklist: CRITICAL_PROCESS_NAMES,
  /** Max destructive operations per minute */
  maxOpsPerMinute: 5,
  /** Minimum cooldown between destructive operations in ms */
  cooldownMs: 3000,
  /** Whether to verify the process owner matches the MCP user */
  verifyOwner: true,
};

/**
 * Parse a comma-separated port list from env var.
 * Returns a Set of port numbers for fast lookup.
 */
function parsePortList(value) {
  if (!value || typeof value !== 'string') return new Set();
  const ports = new Set();
  for (const part of value.split(',')) {
    const trimmed = part.trim();
    if (trimmed === '') continue;
    const num = Number(trimmed);
    if (Number.isInteger(num) && num >= 1 && num <= 65535) {
      ports.add(num);
    }
  }
  return ports;
}

class SafetyConfig {
  constructor(options = {}) {
    const env = process.env;

    this._mode = options.mode || env.PORTS_MCP_MODE || DEFAULTS.mode;

    const envAllowlist = parsePortList(env.PORTS_MCP_ALLOWLIST);
    this._allowlist = options.allowlist
      ? new Set(options.allowlist)
      : (envAllowlist.size > 0 ? envAllowlist : new Set(DEFAULTS.allowlist));

    const envBlocklist = parsePortList(env.PORTS_MCP_BLOCKLIST);
    this._blocklist = options.blocklist
      ? new Set(options.blocklist)
      : (envBlocklist.size > 0 ? envBlocklist : new Set(DEFAULTS.blocklist));

    this._processBlocklist = options.processBlocklist
      ? [...options.processBlocklist]
      : [...DEFAULTS.processBlocklist];

    const envMax = Number(env.PORTS_MCP_MAX_OPS_PER_MINUTE);
    this._maxOpsPerMinute = options.maxOpsPerMinute ?? (
      !Number.isNaN(envMax) ? envMax : DEFAULTS.maxOpsPerMinute
    );

    const envCooldown = Number(env.PORTS_MCP_COOLDOWN_MS);
    this._cooldownMs = options.cooldownMs ?? (
      !Number.isNaN(envCooldown) ? envCooldown : DEFAULTS.cooldownMs
    );

    const envVerify = env.PORTS_MCP_VERIFY_OWNER;
    this._verifyOwner = options.verifyOwner !== undefined
      ? options.verifyOwner
      : (envVerify !== undefined
        ? envVerify !== 'false'
        : DEFAULTS.verifyOwner);

    // Validate mode
    const validModes = ['read-only', 'allowlist', 'blocklist'];
    if (!validModes.includes(this._mode)) {
      console.warn(`[config] Invalid mode "${this._mode}", falling back to "${DEFAULTS.mode}"`);
      this._mode = DEFAULTS.mode;
    }
  }

  // --- Getters ---

  get mode() { return this._mode; }
  get allowlist() { return this._allowlist; }
  get blocklist() { return this._blocklist; }
  get processBlocklist() { return this._processBlocklist; }
  get maxOpsPerMinute() { return this._maxOpsPerMinute; }
  get cooldownMs() { return this._cooldownMs; }
  get verifyOwner() { return this._verifyOwner; }

  // --- Setters (for runtime updates via MCP tools) ---

  setMode(mode) {
    const validModes = ['read-only', 'allowlist', 'blocklist'];
    if (!validModes.includes(mode)) {
      throw new Error(`Invalid mode. Must be one of: ${validModes.join(', ')}`);
    }
    this._mode = mode;
  }

  setAllowlist(ports) {
    this._allowlist = new Set(ports);
  }

  addToAllowlist(port) {
    this._allowlist.add(port);
  }

  removeFromAllowlist(port) {
    this._allowlist.delete(port);
  }

  setBlocklist(ports) {
    this._blocklist = new Set(ports);
  }

  addToBlocklist(port) {
    this._blocklist.add(port);
  }

  removeFromBlocklist(port) {
    this._blocklist.delete(port);
  }

  setMaxOpsPerMinute(n) {
    this._maxOpsPerMinute = n;
  }

  setCooldownMs(ms) {
    this._cooldownMs = ms;
  }

  setVerifyOwner(value) {
    this._verifyOwner = value;
  }

  // --- Snapshot (for MCP tools that return current config) ---

  toJSON() {
    return {
      mode: this._mode,
      allowlist: [...this._allowlist].sort((a, b) => a - b),
      blocklist: [...this._blocklist].sort((a, b) => a - b),
      processBlocklistCount: this._processBlocklist.length,
      maxOpsPerMinute: this._maxOpsPerMinute,
      cooldownMs: this._cooldownMs,
      verifyOwner: this._verifyOwner,
    };
  }
}

module.exports = {
  SafetyConfig,
  CRITICAL_PROCESS_NAMES,
  DEFAULTS,
};
