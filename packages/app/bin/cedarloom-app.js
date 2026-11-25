#!/usr/bin/env node
// Plain syntax only, so an old Node.js reaches the version check before the import loads code it cannot run.
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const required = require('../package.json').engines.node;
const found = process.versions.node;
const json = process.argv.includes('--json');

// The English text of a code from the catalog of core, or the code alone when the catalog does not load.
function messageOf(code, params) {
  let parts;
  try {
    parts = require('@cedarloom/core/messages/en.json').messages[code];
  } catch {
    return code;
  }
  if (parts === undefined) return code;
  return typeof parts === 'string'
    ? parts
    : parts.map((part) => (typeof part === 'string' ? part : params[part[0]])).join('');
}

// As printable of core: control, format and separator characters and lone surrogates as \uXXXX, and a backslash that
// starts text like such an escape as \, so the text and the character it names print apart.
const hidden = /^[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Cs}]$/u;
function escaped(text) {
  return text
    .replace(/\\(?=u([0-9a-fA-F]{4}))/g, (backslash, hex) => {
      const named = String.fromCharCode(Number.parseInt(hex, 16));
      return named === '\\' || hidden.test(named) ? '\\u005c' : backslash;
    })
    .replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Cs}]/gu, (c) =>
      c
        .split('')
        .map((unit) => '\\u' + unit.charCodeAt(0).toString(16).padStart(4, '0'))
        .join(''),
    );
}

function report(document, problem) {
  if (json) process.stdout.write(JSON.stringify(document) + '\n');
  else process.stderr.write(messageOf(problem.code, problem.params) + '\n');
}

if (Number(found.split('.')[0]) >= Number(required.replace('>=', ''))) {
  import('@cedarloom/app')
    .then(function (app) {
      app.run();
    })
    .catch(function (error) {
      // Escaped by core, which never throws on what a thrown value holds; without core, as one line of code points.
      return import('@cedarloom/core')
        .then(
          function (core) {
            process.stderr.write(core.printableStack(error) + '\n');
          },
          function () {
            process.stderr.write(escaped(String(error instanceof Error ? error.stack : error)) + '\n');
          },
        )
        .then(function () {
          const refusal = { code: 'cli.internal', params: {} };
          report({ result: null, findings: [], refusals: [refusal] }, refusal);
          process.exitCode = 5;
        });
    });
} else {
  const finding = { code: 'node.version-unsupported', severity: 'error', params: { found: found, required: required } };
  report({ result: null, findings: [finding], refusals: [] }, finding);
  process.exitCode = 1;
}
