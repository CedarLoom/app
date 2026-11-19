#!/usr/bin/env node
// Plain syntax only, so an old Node.js reaches the version check before the import loads code it cannot run.
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const required = require('../package.json').engines.node;
const found = process.versions.node;

if (Number(found.split('.')[0]) >= Number(required.replace('>=', ''))) {
  import('@cedarloom/app')
    .then(function (app) {
      app.run();
    })
    .catch(function (error) {
      process.stderr.write(String(error.stack) + '\n');
      const document = { result: null, findings: [], refusals: [{ code: 'cli.internal', params: {} }] };
      if (process.argv.includes('--json')) process.stdout.write(JSON.stringify(document) + '\n');
      process.exitCode = 5;
    });
} else {
  const params = { found: found, required: required };
  if (process.argv.includes('--json')) {
    const finding = { code: 'node.version-unsupported', severity: 'error', params: params };
    process.stdout.write(JSON.stringify({ result: null, findings: [finding], refusals: [] }) + '\n');
  } else {
    const parts = require('@cedarloom/core/messages/en.json').messages['node.version-unsupported'];
    process.stderr.write(parts.map((part) => (typeof part === 'string' ? part : params[part[0]])).join('') + '\n');
  }
  process.exitCode = 1;
}
