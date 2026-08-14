const test = require('node:test');
const assert = require('node:assert/strict');

const { identifyProject } = require('../src/project-intelligence');

test('identifyProject recognizes a Vite project from command and working directory evidence', () => {
  const project = identifyProject({
    processName: 'node',
    commandLine: 'node /Users/yoni/Projects/store/node_modules/vite/bin/vite.js --host',
    workingDirectory: '/Users/yoni/Projects/store',
    port: 5173,
  });

  assert.deepEqual(project, {
    name: 'store',
    location: '/Users/yoni/Projects/store',
    framework: 'Vite',
    serviceType: 'development-server',
    confidence: 'high',
  });
});

test('identifyProject reports uncertainty instead of inventing a project for ambiguous processes', () => {
  const project = identifyProject({
    processName: 'node',
    commandLine: 'node server.js',
    port: 3000,
  });

  assert.equal(project.name, 'Node.js service');
  assert.equal(project.framework, 'Node.js');
  assert.equal(project.confidence, 'low');
});
