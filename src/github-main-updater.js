const { execFile } = require('node:child_process');
const { promisify } = require('node:util');

const execFileAsync = promisify(execFile);
const EXPECTED_ORIGIN_URLS = new Set([
  'https://github.com/yonatan2021/ports-mcp.git',
  'git@github.com:yonatan2021/ports-mcp.git',
  'ssh://git@github.com/yonatan2021/ports-mcp.git',
]);

function normalizeOutput(output) {
  return String(output || '').trim();
}

function isExpectedOrigin(url) {
  return EXPECTED_ORIGIN_URLS.has(normalizeOutput(url));
}

async function defaultRun(command, args, options) {
  const { stdout } = await execFileAsync(command, args, {
    cwd: options.cwd,
    encoding: 'utf8',
  });
  return stdout;
}

async function updateFromGitHubMain({ repoDir, run = defaultRun } = {}) {
  if (!repoDir) throw new TypeError('repoDir is required');

  const runGit = (args) => run('git', ['-C', repoDir, ...args], { cwd: repoDir });
  const changes = normalizeOutput(await runGit(['status', '--porcelain']));
  if (changes) return { status: 'dirty' };

  const origin = normalizeOutput(await runGit(['remote', 'get-url', 'origin']));
  if (!isExpectedOrigin(origin)) return { status: 'unexpected-origin', origin };

  const branch = normalizeOutput(await runGit(['branch', '--show-current']));
  if (branch !== 'main') return { status: 'wrong-branch', branch };

  await runGit(['fetch', '--quiet', 'origin', 'main']);
  const currentCommit = normalizeOutput(await runGit(['rev-parse', 'HEAD']));
  const latestCommit = normalizeOutput(await runGit(['rev-parse', 'origin/main']));
  if (currentCommit === latestCommit) return { status: 'up-to-date', commit: currentCommit };

  await runGit(['merge', '--ff-only', 'origin/main']);
  return { status: 'updated', from: currentCommit, to: latestCommit };
}

module.exports = { EXPECTED_ORIGIN_URLS, isExpectedOrigin, updateFromGitHubMain };
