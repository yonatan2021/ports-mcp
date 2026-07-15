const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const packageJson = require('../package.json');

test('desktop artifacts have stable architecture-specific names for the in-app updater', () => {
  assert.equal(packageJson.build.artifactName, 'Port-Manager-${version}-${arch}.${ext}');
  assert.deepEqual(packageJson.build.mac.target, ['dmg', 'zip']);
});

test('tagged versions build, test, and publish both macOS architectures', () => {
  const workflow = fs.readFileSync(path.join(root, '.github', 'workflows', 'release.yml'), 'utf8');
  assert.match(workflow, /tags:\s*\n\s*- ['"]v\*['"]/);
  assert.match(workflow, /npm test/);
  assert.match(workflow, /--arm64 --x64 --publish never/);
  assert.match(workflow, /gh release create/);
  assert.match(workflow, /contents: write/);
});
