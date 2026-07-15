const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const packageJson = require(path.join(__dirname, '..', 'package.json'));

test('macOS release builds use a complete ad-hoc bundle signature', () => {
  assert.equal(packageJson.build?.mac?.identity, '-');
  assert.deepEqual(packageJson.build?.mac?.target, ['dmg', 'zip']);
});
