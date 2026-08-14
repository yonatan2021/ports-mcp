const test = require('node:test');
const assert = require('node:assert/strict');

test('parseReleaseManifest accepts a latest release with both macOS DMG assets', async () => {
  const { parseReleaseManifest } = await import('../scripts/release.mjs');
  const manifest = parseReleaseManifest({
    tag_name: 'v1.2.0',
    published_at: '2026-08-14T12:29:06Z',
    html_url: 'https://github.com/yonatan2021/ports-mcp/releases/tag/v1.2.0',
    assets: [
      { name: 'Port-Manager-1.2.0-arm64.dmg', browser_download_url: 'https://example.test/arm64.dmg' },
      { name: 'Port-Manager-1.2.0-x64.dmg', browser_download_url: 'https://example.test/x64.dmg' },
    ],
  });

  assert.deepEqual(manifest, {
    version: '1.2.0',
    publishedAt: '2026-08-14T12:29:06Z',
    arm64DmgUrl: 'https://example.test/arm64.dmg',
    x64DmgUrl: 'https://example.test/x64.dmg',
    releaseUrl: 'https://github.com/yonatan2021/ports-mcp/releases/tag/v1.2.0',
  });
});

test('parseReleaseManifest rejects releases without trusted architecture assets', async () => {
  const { parseReleaseManifest } = await import('../scripts/release.mjs');
  assert.throws(() => parseReleaseManifest({
    tag_name: 'v1.2.0',
    html_url: 'https://github.com/yonatan2021/ports-mcp/releases/tag/v1.2.0',
    assets: [],
  }), /missing a valid macOS DMG asset/i);
});
