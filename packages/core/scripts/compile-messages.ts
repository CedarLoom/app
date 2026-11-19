// Compiles src/messages/en.po of the package it runs in into en.json, as `lingui compile --namespace json` writes it, and catalog.ts.
import { readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { parsePoFile } from '@lingui/format-po';
import { type CompiledMessage, compileMessageOrThrow } from '@lingui/message-utils/compileMessage';
import { z } from 'zod';

const packageFolder = pathToFileURL(`${process.cwd()}/`);
const manifest = z
  .object({ name: z.string() })
  .parse(JSON.parse(await readFile(new URL('package.json', packageFolder), 'utf8')));
const namespace = manifest.name.replace(/^@cedarloom\//, '');
const folder = new URL('src/messages/', packageFolder);

const argumentsOf = (message: CompiledMessage, found: Set<string>): Set<string> => {
  for (const token of message) {
    if (typeof token === 'string') continue;
    const [name, , choices] = token;
    found.add(name);
    if (typeof choices !== 'object' || choices === null) continue;
    for (const branch of Object.values(choices)) if (Array.isArray(branch)) argumentsOf(branch, found);
  }
  return found;
};

const messages = new Map<string, CompiledMessage>();
for (const item of parsePoFile(await readFile(new URL('en.po', folder), 'utf8')).items) {
  const [text = ''] = item.msgstr;
  // lingui compile leaves obsolete entries out, so one here must not become a live code.
  if (item.obsolete) throw new Error(`${item.msgid} is obsolete`);
  // Lingui reads a msgid as the id only with this flag; without it, it would hash the msgid into another id.
  if (!item.extractedComments.includes('js-lingui-explicit-id'))
    throw new Error(`${item.msgid} has no explicit-id flag`);
  if (text === '') throw new Error(`${item.msgid} has no message`);
  if (messages.has(item.msgid)) throw new Error(`${item.msgid} is defined twice`);
  messages.set(item.msgid, compileMessageOrThrow(text));
}

// Sorted by id, as lingui compile writes them.
const sorted = [...messages].toSorted(([a], [b]) => (a < b ? -1 : 1));
const ids = sorted.map(([id]) => id);
const placeholders = sorted.map(([id, message]) => {
  const names = [...argumentsOf(message, new Set())].toSorted();
  return `  ${JSON.stringify(id)}: ${names.length === 0 ? 'never' : names.map((name) => JSON.stringify(name)).join(' | ')};`;
});

await writeFile(new URL('en.json', folder), JSON.stringify({ messages: Object.fromEntries(sorted) }));
await writeFile(
  new URL('catalog.ts', folder),
  `// Generated from en.po by \`pnpm --filter ${manifest.name} run messages\`; do not edit.

/**
 * The message ids of namespace ${namespace}.
 * @public a catalog lists every id, whether its package reads the list or not.
 */
export const MESSAGE_IDS = [${ids.map((id) => JSON.stringify(id)).join(', ')}] as const;

/** The ICU arguments of each message, by id: the parameter names of its code. */
export interface MessagePlaceholders {
${placeholders.join('\n')}
}
`,
);
