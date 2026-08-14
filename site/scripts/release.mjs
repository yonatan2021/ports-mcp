const REPOSITORY = 'yonatan2021/ports-mcp';
const RELEASE_API_URL = `https://api.github.com/repos/${REPOSITORY}/releases/latest`;

function normalizedVersion(tag) {
  return typeof tag === 'string' ? tag.replace(/^v/, '') : '';
}

function validUrl(value) {
  try {
    return new URL(value).protocol === 'https:';
  } catch {
    return false;
  }
}

export function parseReleaseManifest(release) {
  const version = normalizedVersion(release?.tag_name);
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new TypeError('Latest release has an invalid version');
  if (!validUrl(release?.html_url)) throw new TypeError('Latest release has an invalid release URL');

  const assets = Array.isArray(release.assets) ? release.assets : [];
  const byName = new Map(assets.map((asset) => [asset?.name, asset?.browser_download_url]));
  const arm64DmgUrl = byName.get(`Port-Manager-${version}-arm64.dmg`);
  const x64DmgUrl = byName.get(`Port-Manager-${version}-x64.dmg`);
  if (!validUrl(arm64DmgUrl) || !validUrl(x64DmgUrl)) {
    throw new TypeError('Latest release is missing a valid macOS DMG asset for Apple Silicon or Intel');
  }

  return {
    version,
    publishedAt: typeof release.published_at === 'string' ? release.published_at : '',
    arm64DmgUrl,
    x64DmgUrl,
    releaseUrl: release.html_url,
  };
}

export async function fetchLatestRelease(fetchImpl = globalThis.fetch, token = process.env.GITHUB_TOKEN) {
  const headers = { Accept: 'application/vnd.github+json', 'User-Agent': 'port-manager-site-build' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const response = await fetchImpl(RELEASE_API_URL, { headers });
  if (!response.ok) throw new Error(`GitHub latest release request failed with ${response.status}`);
  return parseReleaseManifest(await response.json());
}
