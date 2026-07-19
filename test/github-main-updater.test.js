const test = require('node:test');
const assert = require('node:assert/strict');
const { isExpectedOrigin, updateFromGitHubMain } = require('../src/github-main-updater');

const REPO_DIR = '/tmp/ports-mcp';
const ORIGIN = 'https://github.com/yonatan2021/ports-mcp.git';

function createRunner(overrides = {}) {
  const calls = [];
  const outputs = new Map([
    ['status --porcelain', ''],
    ['remote get-url origin', ORIGIN],
    ['branch --show-current', 'main'],
    ['rev-parse HEAD', 'old-commit'],
    ['rev-parse origin/main', 'new-commit'],
  ]);
  Object.entries(overrides).forEach(([key, value]) => outputs.set(key, value));

  return {
    calls,
    run: async (command, args) => {
      assert.equal(command, 'git');
      assert.deepEqual(args.slice(0, 2), ['-C', REPO_DIR]);
      const key = args.slice(2).join(' ');
      calls.push(key);
      return outputs.get(key) || '';
    },
  };
}

test('recognizes only this repository as a GitHub main update source', () => {
  assert.equal(isExpectedOrigin(ORIGIN), true);
  assert.equal(isExpectedOrigin('git@github.com:yonatan2021/ports-mcp.git'), true);
  assert.equal(isExpectedOrigin('https://github.com/example/other.git'), false);
});

test('updates a clean main checkout by fast-forwarding origin/main only', async () => {
  const { calls, run } = createRunner();

  const result = await updateFromGitHubMain({ repoDir: REPO_DIR, run });

  assert.deepEqual(result, { status: 'updated', from: 'old-commit', to: 'new-commit' });
  assert.deepEqual(calls, [
    'status --porcelain',
    'remote get-url origin',
    'branch --show-current',
    'fetch --quiet origin main',
    'rev-parse HEAD',
    'rev-parse origin/main',
    'merge --ff-only origin/main',
  ]);
});

test('refuses to update a checkout with uncommitted changes', async () => {
  const { calls, run } = createRunner({ 'status --porcelain': ' M public/app.js' });

  const result = await updateFromGitHubMain({ repoDir: REPO_DIR, run });

  assert.deepEqual(result, { status: 'dirty' });
  assert.deepEqual(calls, ['status --porcelain']);
});

test('does not update from a different origin or branch', async (t) => {
  await t.test('different origin', async () => {
    const { calls, run } = createRunner({ 'remote get-url origin': 'https://github.com/example/other.git' });
    const result = await updateFromGitHubMain({ repoDir: REPO_DIR, run });
    assert.deepEqual(result, { status: 'unexpected-origin', origin: 'https://github.com/example/other.git' });
    assert.deepEqual(calls, ['status --porcelain', 'remote get-url origin']);
  });

  await t.test('non-main branch', async () => {
    const { calls, run } = createRunner({ 'branch --show-current': 'feature/experiment' });
    const result = await updateFromGitHubMain({ repoDir: REPO_DIR, run });
    assert.deepEqual(result, { status: 'wrong-branch', branch: 'feature/experiment' });
    assert.deepEqual(calls, ['status --porcelain', 'remote get-url origin', 'branch --show-current']);
  });
});

test('does not merge when origin/main already matches HEAD', async () => {
  const { calls, run } = createRunner({ 'rev-parse origin/main': 'old-commit' });

  const result = await updateFromGitHubMain({ repoDir: REPO_DIR, run });

  assert.deepEqual(result, { status: 'up-to-date', commit: 'old-commit' });
  assert.equal(calls.includes('merge --ff-only origin/main'), false);
});

test('throws TypeError when repoDir is not provided', async () => {
  await assert.rejects(
    () => updateFromGitHubMain({}),
    /repoDir is required/
  );
});

test('propagates errors when git execution fails', async () => {
  const run = async () => {
    throw new Error('git execution failed');
  };

  await assert.rejects(
    () => updateFromGitHubMain({ repoDir: REPO_DIR, run }),
    /git execution failed/
  );
});

