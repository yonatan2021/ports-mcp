const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const indexHtml = fs.readFileSync(path.join(root, 'public', 'index.html'), 'utf8');
const styleCss = fs.readFileSync(path.join(root, 'public', 'style.css'), 'utf8');

test('the app exposes one Hebrew main landmark after a keyboard skip link', () => {
  const skipLink = indexHtml.indexOf('class="skip-link"');
  const appShell = indexHtml.indexOf('class="app-container"');

  assert.ok(skipLink >= 0 && skipLink < appShell, 'skip link must be the first app control');
  assert.match(indexHtml, /<a href="#main-content" class="skip-link">דלג לתוכן הראשי<\/a>/);
  assert.match(indexHtml, /<main id="main-content" class="app-content-area" tabindex="-1">/);
  assert.equal((indexHtml.match(/<main\b/g) || []).length, 1, 'the application must have one main landmark');
});

test('the primary navigation is a project-first macOS sidebar without emoji icons', () => {
  assert.match(indexHtml, /<aside class="app-sidebar" aria-label="סרגל צד">/);
  assert.match(indexHtml, /class="sidebar-section-label"[^>]*>סביבת פיתוח</);
  assert.match(indexHtml, /id="tab-btn-ports"[\s\S]*?aria-label="פרויקטים פעילים"[\s\S]*?<span class="nav-text">פרויקטים<\/span>/);
  assert.match(indexHtml, /class="sidebar-section-label"[^>]*>כלי מערכת</);

  const navigation = indexHtml.match(/<nav class="top-navigation[\s\S]*?<\/nav>/)?.[0] || '';
  assert.ok(navigation.includes('<svg'), 'sidebar navigation must use a consistent SVG icon system');
  assert.doesNotMatch(navigation, /[\u{1F300}-\u{1FAFF}]/u);
});

test('the project workspace uses human language while keeping technical details available', () => {
  assert.match(indexHtml, /<p class="eyebrow">מה רץ אצלך עכשיו<\/p>/);
  assert.match(indexHtml, /<h2 id="current-view-title">הפרויקטים והשירותים המקומיים שלך<\/h2>/);
  assert.match(indexHtml, /placeholder="חיפוש לפי פרויקט, כלי פיתוח או פורט…"/);
  assert.match(indexHtml, /data-filter="system-resources">כל התהליכים<\/button>/);
  assert.match(indexHtml, /id="view-mode-detailed"[\s\S]*?>[\s\S]*?פרטים טכניים<\/button>/);
});

test('the shell follows system appearance with explicit theme overrides and cheap surfaces', () => {
  assert.match(styleCss, /color-scheme:\s*light dark/);
  assert.match(styleCss, /@media \(prefers-color-scheme:\s*dark\)/);
  assert.match(styleCss, /html\[data-theme="light"\]/);
  assert.match(styleCss, /html\[data-theme="dark"\]/);
  assert.match(styleCss, /\.app-sidebar\s*\{[\s\S]*?border-inline-end:/);
  assert.match(styleCss, /\.app-shell-surface,[\s\S]*?backdrop-filter:\s*none/);
  assert.match(styleCss, /@media \(prefers-reduced-motion:\s*reduce\)/);
});

test('technical values remain selectable and keyboard focus is always visible', () => {
  assert.match(styleCss, /:where\(button, a, input, select, summary, \[tabindex\]\):focus-visible/);
  assert.match(styleCss, /:where\(code, pre, \[dir="ltr"\], \.font-mono\)[\s\S]*?user-select:\s*text/);
  assert.match(styleCss, /\.skip-link:focus/);
});
