const LATEST_RELEASE_URL = 'https://api.github.com/repos/yonatan2021/ports-mcp/releases/latest';
const RELEASES_URL = 'https://github.com/yonatan2021/ports-mcp/releases';

function normalizeVersion(version) {
  return String(version || '').trim().replace(/^v/i, '');
}

function versionParts(version) {
  const match = normalizeVersion(version).match(/^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/);
  return match ? match.slice(1).map(Number) : null;
}

function isNewerVersion(candidate, current) {
  const candidateParts = versionParts(candidate);
  const currentParts = versionParts(current);
  if (!candidateParts || !currentParts) return false;

  for (let index = 0; index < candidateParts.length; index += 1) {
    if (candidateParts[index] > currentParts[index]) return true;
    if (candidateParts[index] < currentParts[index]) return false;
  }
  return false;
}

function createAppInfoProvider({ currentVersion, fetchImpl = globalThis.fetch } = {}) {
  const normalizedCurrentVersion = normalizeVersion(currentVersion);
  if (!normalizedCurrentVersion) throw new TypeError('currentVersion is required');
  if (typeof fetchImpl !== 'function') throw new TypeError('fetchImpl must be a function');

  return async function getAppInfo() {
    const fallback = {
      currentVersion: normalizedCurrentVersion,
      latestVersion: null,
      updateAvailable: false,
      releaseUrl: RELEASES_URL,
    };

    try {
      const response = await fetchImpl(LATEST_RELEASE_URL, {
        headers: {
          Accept: 'application/vnd.github+json',
          'User-Agent': `ports-mcp/${normalizedCurrentVersion}`,
          'X-GitHub-Api-Version': '2022-11-28',
        },
        signal: AbortSignal.timeout(5000),
      });
      if (!response.ok) return fallback;

      const release = await response.json();
      const latestVersion = normalizeVersion(release.tag_name);
      if (!versionParts(latestVersion)) return fallback;

      return {
        currentVersion: normalizedCurrentVersion,
        latestVersion,
        updateAvailable: isNewerVersion(latestVersion, normalizedCurrentVersion),
        releaseUrl: typeof release.html_url === 'string' && release.html_url.startsWith('https://github.com/yonatan2021/ports-mcp/releases/')
          ? release.html_url
          : RELEASES_URL,
      };
    } catch (_error) {
      return fallback;
    }
  };
}

module.exports = {
  LATEST_RELEASE_URL,
  RELEASES_URL,
  createAppInfoProvider,
  isNewerVersion,
  normalizeVersion,
};
