import { type JsonValue, printable, type WorkflowShown, type WorkflowValidation } from '@cedarloom/core';
import { listWorkflows, showWorkflow, validateWorkflows } from '@cedarloom/use-cases';
import type { Io } from './io.ts';
import { message } from './message.ts';
import { columns, type Outcome } from './output.ts';

const fieldOf = (value: JsonValue | undefined, key: string): JsonValue | undefined =>
  typeof value === 'object' && value !== null && !Array.isArray(value) ? value[key] : undefined;
const textOf = (value: JsonValue | undefined): string => (typeof value === 'string' ? value : '');
const listOf = (value: JsonValue | undefined): JsonValue[] => (Array.isArray(value) ? value : []);

// Each stage and phase by its JSON Pointer, so an edit can address it: id, run, agent or step, model.
const outline = (definition: JsonValue): string[][] =>
  listOf(fieldOf(definition, 'stages')).flatMap((stage, i) => {
    const phases = listOf(fieldOf(stage, 'phases')).map((phase, j) => [
      `/stages/${i}/phases/${j}`,
      textOf(fieldOf(phase, 'id')),
      textOf(fieldOf(phase, 'run')),
      textOf(fieldOf(phase, 'agent') ?? fieldOf(phase, 'step')),
      textOf(fieldOf(phase, 'model')),
    ]);
    // Five cells like a phase row, so columns aligns every row.
    return [[`/stages/${i}`, textOf(fieldOf(stage, 'id')), '', '', '']].concat(phases);
  });

const shownText = ({ definition }: WorkflowShown): string => {
  const rows = outline(definition);
  const file = JSON.stringify(definition, null, 2).split('\n').map(printable).join('\n');
  return `${rows.length === 0 ? '' : `${columns(rows)}\n`}${file}\n`;
};

const isFailed = ({ generatorRefusals, refusals }: WorkflowValidation['definitions'][number]): boolean =>
  generatorRefusals.length > 0 || refusals.length > 0;

// A line per definition, and below an invalid one a line per refusal: the generator's file, field and rule as it gave them.
const validationText = ({ definitions }: WorkflowValidation): string => {
  if (definitions.length === 0) return `${message('output.workflows-none')}\n`;
  return definitions
    .flatMap((definition) => {
      const { name, source, generatorRefusals, refusals } = definition;
      const head = message(isFailed(definition) ? 'output.workflow-invalid' : 'output.workflow-valid', {
        name,
        source,
      });
      const lines = generatorRefusals.map(
        ({ file, field, rule }) => `  ${[file, field, rule].map(printable).join('  ')}`,
      );
      return [head, ...lines, ...refusals.map(({ code, params }) => `  ${message(code, params)}`)];
    })
    .map((line) => `${line}\n`)
    .join('');
};

/** cedarloom workflows list: the shipped definitions and the project's own. */
export const workflowsList = (io: Io, pluginRoot: string | null): Outcome => {
  const { result, findings, refusals } = listWorkflows({ ...io, pluginRoot });
  if (result === null) return { result, findings, refusals, text: '' };
  const rows = result.workflows.map(({ name, source, path, description }) => [name, source, path, description ?? '']);
  return {
    result,
    findings,
    refusals,
    text: rows.length === 0 ? `${message('output.workflows-none')}\n` : columns(rows),
  };
};

/** cedarloom workflows show <name>: a project definition, or with --shipped the plugin's. */
export const workflowsShow = (io: Io, name: string, shipped: boolean, pluginRoot: string | null): Outcome => {
  const { result, findings, refusals } = showWorkflow({ ...io, pluginRoot }, name, shipped);
  return { result, findings, refusals, text: result === null ? '' : shownText(result) };
};

/** cedarloom workflows validate [<name>...]: the generator's refusals of each definition; any refusal fails the check. */
export const workflowsValidate = (
  io: Io,
  names: readonly string[],
  shipped: boolean,
  pluginRoot: string | null,
): Outcome => {
  const { result, findings, refusals } = validateWorkflows({ ...io, pluginRoot }, names, shipped);
  const failed = (result?.definitions ?? []).some(isFailed);
  return { result, findings, refusals, failed, text: result === null ? '' : validationText(result) };
};
