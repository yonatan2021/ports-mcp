const test = require('node:test');
const assert = require('node:assert/strict');
const { createPersistentCache } = require('../public/persistent-cache');

function createStorage() {
  const data = new Map();
  return {
    getItem: key => data.has(key) ? data.get(key) : null,
    setItem: (key, value) => data.set(key, value),
  };
}

test('persistent cache returns fresh data and ignores expired or malformed records', () => {
  let now = 1_000;
  const storage = createStorage();
  const cache = createPersistentCache({ storage, now: () => now });

  cache.write('storage', { disk: { percentage: 40 } });
  assert.deepEqual(cache.read('storage', 300), { disk: { percentage: 40 } });

  now += 300;
  assert.equal(cache.read('storage', 300), null);

  storage.setItem('broken', '{not json');
  assert.equal(cache.read('broken', 300), null);
});
