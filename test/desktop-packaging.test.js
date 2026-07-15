const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const packageJson = require(path.join(__dirname, '..', 'package.json'));
const mainSource = fs.readFileSync(path.join(__dirname, '..', 'desktop', 'main.js'), 'utf8');
const preloadPath = path.join(__dirname, '..', 'desktop', 'preload.js');

test('macOS release builds use a complete ad-hoc bundle signature', () => {
  assert.equal(packageJson.build?.mac?.identity, '-');
  assert.deepEqual(packageJson.build?.mac?.target, ['dmg', 'zip']);
});

test('desktop updates are exposed only through an isolated Electron IPC preload bridge', () => {
  assert.equal(fs.existsSync(preloadPath), true);
  const preloadSource = fs.readFileSync(preloadPath, 'utf8');
  assert.match(preloadSource, /contextBridge\.exposeInMainWorld\('portManager'/);
  assert.match(preloadSource, /ipcRenderer\.invoke\('app-update'\)/);
  assert.match(mainSource, /preload:\s*path\.join\(__dirname, 'preload\.js'\)/);
  assert.match(mainSource, /ipcMain\.handle\('app-update'/);
  assert.match(mainSource, /webContents\.on\('will-navigate'/);
  assert.match(mainSource, /webContents\.on\('will-redirect'/);
  assert.doesNotMatch(mainSource, /updateToken|randomBytes/);
});
