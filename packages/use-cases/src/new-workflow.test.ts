import { mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { newWorkflow } from './new-workflow.ts';
import { fresh, store } from './test-fixtures.ts';

// A stub generator that refuses every definition file it is given at the field stages.
const REFUSING = `const files = process.argv.slice(2, process.argv.indexOf('--json'));
process.stdout.write(JSON.stringify(files.map((file) => ({ file, field: 'stages', rule: 'refused' }))));
process.exitCode = 1;
`;

// workflows new mine --from full in a fresh project, with the stub generator and the shipped definition given.
const created = (shipped: string) => {
  const [root, plugin] = [realpathSync(fresh()), realpathSync(fresh())];
  mkdirSync(join(plugin, 'generator'));
  mkdirSync(join(plugin, 'definitions'));
  writeFileSync(join(plugin, 'generator', 'generate.mjs'), REFUSING);
  writeFileSync(join(plugin, 'definitions', 'full.json'), shipped);
  const request = { root, cwd: root, env: {}, home: fresh(), pluginRoot: plugin, name: 'mine', from: 'full' };
  return { plugin, generation: newWorkflow(store(fresh()), request, true) };
};

it("names the shipped definition in the generator's refusals of a new workflow", () => {
  const { plugin, generation } = created('{ "schemaVersion": 2, "name": "full" }');
  expect(generation).toMatchObject({
    plan: null,
    generatorRefusals: [{ file: join(plugin, 'definitions', 'full.json'), field: 'stages', rule: 'refused' }],
  });
});

it('refuses a new workflow whose indented copy would be larger than 16 MiB', () => {
  // 600,000 zeros 21 levels deep: 1.2 MB as written, 27 MB with two spaces of indent per level.
  const zeros = `[${Array.from({ length: 600_000 }, () => '0').join(',')}]`;
  const nested = `${'{"a":'.repeat(19)}${zeros}${'}'.repeat(19)}`;
  const { generation } = created(`{ "schemaVersion": 2, "name": "full", "deep": ${nested} }`);
  expect(generation).toMatchObject({ plan: null, refusals: [{ code: 'edit.result-over-limits' }] });
});
