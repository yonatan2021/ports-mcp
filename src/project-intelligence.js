const path = require('node:path');

function frameworkFromEvidence(commandLine = '', processName = '', port) {
  const evidence = `${commandLine} ${processName}`.toLowerCase();
  if (/\bnext(?:\s|\/|$)|next\/dist/.test(evidence)) return ['Next.js', 'development-server'];
  if (/\bvite(?:\s|\/|$)|vite\.js/.test(evidence)) return ['Vite', 'development-server'];
  if (/\b(flask|gunicorn)\b/.test(evidence)) return ['Flask', 'development-server'];
  if (/\bdjango|manage\.py/.test(evidence)) return ['Django', 'development-server'];
  if (/\b(bun|deno)\b/.test(evidence)) return [evidence.includes('deno') ? 'Deno' : 'Bun', 'development-server'];
  if (/postgres|postmaster/.test(evidence) || port === 5432) return ['PostgreSQL', 'database'];
  if (/redis/.test(evidence) || port === 6379) return ['Redis', 'database'];
  if (/mongo/.test(evidence) || port === 27017) return ['MongoDB', 'database'];
  if (/mysql/.test(evidence) || port === 3306) return ['MySQL', 'database'];
  if (/docker/.test(evidence)) return ['Docker', 'container-service'];
  if (/\bpython/.test(evidence)) return ['Python', 'development-server'];
  if (/\bnode\b/.test(evidence)) return ['Node.js', 'development-server'];
  return [processName || 'Local service', 'service'];
}

function identifyProject(processInfo = {}) {
  const location = typeof processInfo.workingDirectory === 'string' && processInfo.workingDirectory.startsWith('/')
    ? processInfo.workingDirectory
    : null;
  const [framework, serviceType] = frameworkFromEvidence(processInfo.commandLine, processInfo.processName, processInfo.port);
  const name = location ? path.basename(location) : `${framework} service`;
  const strongFrameworkEvidence = /next|vite|flask|django|bun|deno/i.test(processInfo.commandLine || '');

  return {
    name,
    location,
    framework,
    serviceType,
    confidence: location && strongFrameworkEvidence ? 'high' : location || framework !== 'Node.js' ? 'medium' : 'low',
  };
}

module.exports = { identifyProject };
