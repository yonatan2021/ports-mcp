const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const appSource = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');

function extractFunction(name) {
  const start = appSource.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `${name} must be defined in app.js`);

  const declarationEnd = appSource.indexOf('\n', start);
  const bodyStart = appSource.lastIndexOf('{', declarationEnd);
  let depth = 0;
  let quote = null;
  let escaped = false;

  for (let index = bodyStart; index < appSource.length; index += 1) {
    const character = appSource[index];
    if (quote) {
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === quote) quote = null;
      continue;
    }
    if (character === '"' || character === "'" || character === '`') {
      quote = character;
      continue;
    }
    if (character === '{') depth += 1;
    if (character === '}') {
      depth -= 1;
      if (depth === 0) return appSource.slice(start, index + 1);
    }
  }

  throw new Error(`Could not extract ${name}`);
}

function loadFunction(name, globals = {}) {
  const context = vm.createContext({
    AbortController,
    DOMException,
    Map,
    Promise,
    setTimeout,
    clearTimeout,
    ...globals
  });
  vm.runInContext(`${extractFunction(name)}; globalThis.exported = ${name};`, context);
  return context.exported;
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

test('resource client coalesces concurrent requests for the same resource', async () => {
  const createResourceClient = loadFunction('createResourceClient');
  const pending = deferred();
  let fetchCount = 0;
  const client = createResourceClient(async () => {
    fetchCount += 1;
    return pending.promise;
  });

  const first = client.getJson('ports', '/api/ports');
  const second = client.getJson('ports', '/api/ports');

  assert.strictEqual(first, second);
  assert.equal(fetchCount, 1);

  pending.resolve({ ok: true, json: async () => ({ ports: [] }) });
  assert.deepEqual(await first, { ports: [] });
});

test('forced resource refresh aborts the obsolete request', async () => {
  const createResourceClient = loadFunction('createResourceClient');
  const calls = [];
  const client = createResourceClient((url, options) => {
    const pending = deferred();
    calls.push({ url, options, pending });
    options.signal.addEventListener('abort', () => {
      pending.reject(new DOMException('Request superseded', 'AbortError'));
    });
    return pending.promise;
  });

  const obsolete = client.getJson('ports', '/api/ports');
  const replacement = client.getJson('ports', '/api/ports?bypassCache=true', { force: true });

  assert.equal(calls.length, 2);
  assert.equal(calls[0].options.signal.aborted, true);
  await assert.rejects(obsolete, error => error.name === 'AbortError');

  calls[1].pending.resolve({ ok: true, json: async () => ({ ports: [{ port: 3000 }] }) });
  assert.deepEqual(await replacement, { ports: [{ port: 3000 }] });
});

test('view poller never overlaps a slow task', async () => {
  const createViewPoller = loadFunction('createViewPoller');
  const pending = deferred();
  let taskCalls = 0;
  const poller = createViewPoller({
    interval: 1000,
    isVisible: () => true,
    isViewActive: () => true,
    task: () => {
      taskCalls += 1;
      return pending.promise;
    }
  });

  const first = poller.runNow();
  const second = poller.runNow();

  assert.strictEqual(first, second);
  assert.equal(taskCalls, 1);
  pending.resolve();
  await first;
  poller.stop();
});

test('view poller skips work while hidden or inactive', async () => {
  const createViewPoller = loadFunction('createViewPoller');
  let visible = false;
  let active = true;
  let taskCalls = 0;
  const poller = createViewPoller({
    interval: 1000,
    isVisible: () => visible,
    isViewActive: () => active,
    task: async () => { taskCalls += 1; }
  });

  assert.equal(await poller.runNow(), false);
  visible = true;
  active = false;
  assert.equal(await poller.runNow(), false);
  active = true;
  assert.equal(await poller.runNow(), true);
  assert.equal(taskCalls, 1);
  poller.stop();
});

test('renderer registers native refresh and settings shortcuts', () => {
  assert.match(appSource, /event\.code === 'KeyR'/);
  assert.match(appSource, /event\.code === 'Comma'/);
  assert.match(appSource, /window\.SafetySettings\?\.open\(\)/);
  assert.match(appSource, /refreshCurrentView\(\{ force: true \}\)/);
});
