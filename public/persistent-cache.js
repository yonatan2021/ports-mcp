(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.PersistentCache = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  function createPersistentCache({ storage = globalThis.localStorage, now = () => Date.now() } = {}) {
    function read(key, ttlMs) {
      try {
        const record = JSON.parse(storage.getItem(key));
        if (!record || typeof record.timestamp !== 'number' || now() - record.timestamp >= ttlMs) return null;
        return record.data ?? null;
      } catch {
        return null;
      }
    }

    function write(key, data) {
      try {
        storage.setItem(key, JSON.stringify({ timestamp: now(), data }));
      } catch {
        // Storage can be unavailable in restricted browser contexts.
      }
    }

    return { read, write };
  }

  return { createPersistentCache };
});
