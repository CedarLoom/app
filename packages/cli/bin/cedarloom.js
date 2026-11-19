#!/usr/bin/env node
// Plain syntax only, so an old Node.js reaches the version check before the import loads code it cannot run.
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const manifest = require('../package.json');
const json = process.argv.includes('--json');

// The English text of a code, from the compiled catalog of core.
function text(code, params) {
  const message = require('@cedarloom/core/messages/en.json').messages[code];
  if (typeof message === 'string') return message;
  return message
    .map(function (token) {
      return typeof token === 'string' ? token : params[token[0]];
    })
    .join('');
}

function stop(document, problem, exitCode) {
  if (json) process.stdout.write(JSON.stringify(document) + '\n');
  else process.stderr.write(text(problem.code, problem.params) + '\n');
  process.exitCode = exitCode;
}

const required = manifest.engines.node;
const found = process.versions.node;
if (Number(found.split('.')[0]) < Number(required.replace('>=', ''))) {
  const finding = { code: 'node.version-unsupported', severity: 'error', params: { found: found, required: required } };
  stop({ result: null, findings: [finding], refusals: [] }, finding, 1);
} else {
  import('@cedarloom/cli')
    .then(function (cli) {
      cli.run(manifest);
    })
    .catch(function (error) {
      process.stderr.write(String(error.stack) + '\n');
      const refusal = { code: 'cli.internal', params: {} };
      stop({ result: null, findings: [], refusals: [refusal] }, refusal, 5);
    });
}
