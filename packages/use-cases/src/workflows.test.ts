import { existsSync, mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { expect, it } from 'vitest';
import { definitionFindings } from './definition-checks.ts';
import { definitionOf, planGeneration } from './generate.ts';
import { fresh, store as storeIn } from './test-fixtures.ts';
import { listWorkflows, projectPlace, showWorkflow, validateWorkflows } from './workflows.ts';

const folder = (): string => realpathSync(fresh());

const put = (path: string, text: string): void => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
};

// A project with a plugin root whose generator accepts every definition and writes nothing; what generate, validate
// and the doctor refuse in it.
const setup = () => {
  const project = folder();
  mkdirSync(join(project, '.git'));
  const plugin = folder();
  put(join(plugin, 'generator', 'generate.mjs'), "console.log('[]');\n");
  mkdirSync(join(plugin, 'definitions'));
  const store = storeIn(folder());
  const request = { cwd: project, env: {}, home: folder(), pluginRoot: plugin };
  const define = (file: string, text: string) => put(join(project, '.cedarloom', 'workflows', file), text);
  const refused = (names: string[]) => {
    const validated = validateWorkflows(request, names, false);
    const each = validated.result?.definitions.flatMap(({ refusals }) => refusals) ?? [];
    return {
      generate: planGeneration(store, { ...request, root: project, names }).refusals,
      validate: [...validated.refusals, ...each],
    };
  };
  const doctor = () =>
    definitionFindings({ project, root: plugin, temp: folder(), timeoutMs: 20_000, env: {} }).definitions.map(
      ({ code, params }) => ({ code, params }),
    );
  return { project, request, define, refused, doctor };
};

const mismatch = (file: string, name: string) => ({
  code: 'definition.name-mismatch',
  params: { file: `.cedarloom/workflows/${file}`, name },
});

it('finds Build.json by no other spelling and refuses its name alike in every verb, where the volume folds case', ({
  skip,
}) => {
  const { project, request, define, refused, doctor } = setup();
  define('Build.json', '{ "name": "build" }');
  if (!existsSync(join(project, '.cedarloom', 'workflows', 'build.json'))) skip('this volume tells the cases apart');
  const notFound = { code: 'definition.not-found', params: { name: 'build', source: 'project' } };
  const named = {
    run: refused(['build']),
    // edit and switch read a definition by its name alone.
    edit: definitionOf(projectPlace(project), { name: 'build', path: '.cedarloom/workflows/build.json' }),
    show: showWorkflow(request, 'build', false).refusals,
  };
  expect([named, refused([]), doctor()]).toEqual([
    { run: { generate: [notFound], validate: [notFound] }, edit: notFound, show: [notFound] },
    { generate: [mismatch('Build.json', 'build')], validate: [mismatch('Build.json', 'build')] },
    [mismatch('Build.json', 'build')],
  ]);
});

it('refuses a definition with a __proto__ member named other than its file alike in generate and validate', () => {
  const { define, refused } = setup();
  define('dev.json', '{ "name": "other", "__proto__": {} }');
  expect(refused(['dev'])).toEqual({
    generate: [mismatch('dev.json', 'other')],
    validate: [mismatch('dev.json', 'other')],
  });
});

it.each([
  ['a number', '5', '5'],
  ['an object', '{ "first": "dev" }', '{"first":"dev"}'],
  ['longer than 4096 characters, cut there', JSON.stringify('d'.repeat(5000)), 'd'.repeat(4096)],
])('refuses a definition whose name is %s with definition.name-mismatch', (_, name, shown) => {
  const { define, refused } = setup();
  define('dev.json', `{ "name": ${name} }`);
  expect(refused(['dev'])).toEqual({
    generate: [mismatch('dev.json', shown)],
    validate: [mismatch('dev.json', shown)],
  });
});

it('lists a definition named outside the name form with a workflow.name-invalid warning', () => {
  const { define, request } = setup();
  define('Release_Flow.json', '{ "name": "Release_Flow" }');
  const listed = listWorkflows(request);
  expect(listed.result).toMatchObject({ workflows: [{ name: 'Release_Flow', source: 'project' }] });
  expect(listed.findings.filter(({ code }) => code.startsWith('workflow.'))).toEqual([
    { code: 'workflow.name-invalid', severity: 'warning', params: { name: 'Release_Flow', longest: 166 } },
  ]);
});
