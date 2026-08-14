import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { copy } from './content.mjs';
import { fetchLatestRelease } from './release.mjs';
import { page } from './template.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const output = resolve(root, '..', 'dist');
const source = resolve(root, 'src');
const siteUrl = (process.env.SITE_URL || '').replace(/\/$/, '');

async function write(path, value) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, value);
}

const release = await fetchLatestRelease();
await rm(output, { recursive: true, force: true });
await cp(resolve(source, 'assets'), resolve(output, 'assets'), { recursive: true });

for (const locale of ['he', 'en']) {
  const c = copy[locale];
  await write(resolve(output, locale, 'index.html'), page({ c, release, siteUrl }));
  await write(resolve(output, locale, 'privacy', 'index.html'), page({ c, release, siteUrl, privacy: true }));
}

await write(resolve(output, 'index.html'), '<!doctype html><meta http-equiv="refresh" content="0; url=/he/"><link rel="canonical" href="/he/">');
await write(resolve(output, 'robots.txt'), 'User-agent: *\nAllow: /\nSitemap: ' + (siteUrl ? `${siteUrl}/sitemap.xml` : '/sitemap.xml') + '\n');
await write(resolve(output, 'sitemap.xml'), `<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${['/he/', '/en/', '/he/privacy/', '/en/privacy/'].map((path) => `<url><loc>${siteUrl || 'https://example.invalid'}${path}</loc></url>`).join('')}</urlset>`);
await write(resolve(output, 'release-manifest.json'), JSON.stringify(release, null, 2));
console.log(`Built Port Manager site for release ${release.version}`);
