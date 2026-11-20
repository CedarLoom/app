import { z } from 'zod';
import type { Finding } from './finding.ts';
import { inserted, membersOf, openAt, removed } from './json-text.ts';
import type { Action, SettingsEntry } from './run.ts';

const DENY = ['permissions', 'deny'];
const DENY_POINTER = '/permissions/deny';
const PLUGINS = 'enabledPlugins';

// Only the shape the switches read; every other member stays as it is.
const Settings = z.object({
  permissions: z.object({ deny: z.array(z.unknown()).optional() }).optional(),
  enabledPlugins: z.record(z.string(), z.unknown()).optional(),
});
type Settings = z.infer<typeof Settings>;
const isSettings = (json: unknown): json is Settings => Settings.safeParse(json).success;

/** A switch run in effect, done or stopped, or an undo of one as the opposite action, with its settings entries. */
export interface SwitchRecord {
  action: Action;
  entries: readonly SettingsEntry[];
}

/** The deny rules to switch, or the enabledPlugins key. */
export type SwitchTarget = { rules: readonly string[] } | { plugin: string };

/**
 * A settings file's new text, null when it stays as it is; the entries the run records; the entries it left, and
 * warnings on owner entries it changes.
 */
export interface Switched {
  text: string | null;
  entries: SettingsEntry[];
  skipped: Finding[];
}

/** The settings file: its text, null when it does not exist, and its path for the findings. */
export interface SettingsText {
  text: string | null;
  path: string;
}

interface Draft {
  text: string;
  json: Settings;
  entries: SettingsEntry[];
  skipped: Finding[];
  path: string;
  records: readonly SwitchRecord[];
}

// The app owns an entry while the newest run in effect that holds its pointer (and value) switched off.
const owned = (draft: Draft, pointer: string, value?: string): SettingsEntry | undefined => {
  for (const { action, entries } of draft.records) {
    const entry = entries.find((each) => each.pointer === pointer && (value === undefined || each.value === value));
    if (entry !== undefined) return action === 'workflow.off' ? entry : undefined;
  }
  return undefined;
};

// kept false: the plan changes the owner's entry.
const ownerEntry = (draft: Draft, key: string, kept = true): void => {
  draft.skipped.push({ code: 'settings.owner-entry', severity: 'warning', params: { path: draft.path, key, kept } });
};

const denied = (draft: Draft): unknown[] => draft.json.permissions?.deny ?? [];

const pointerOf = (plugin: string): string => `/${PLUGINS}/${plugin}`;

// The text with `value` added at the end of the container the keys name, made with the containers missing on the way.
const appended = (text: string, keys: readonly string[], key: string | null, value: string | boolean): string => {
  let open = text.indexOf('{');
  for (const [depth, name] of keys.entries()) {
    const next = openAt(text, keys.slice(0, depth + 1));
    if (next === undefined) {
      const inner = key === null ? [value] : { [key]: value };
      const nested = keys.slice(depth + 1).reduceRight<unknown>((made, outer) => ({ [outer]: made }), inner);
      return inserted(text, open, `${JSON.stringify(name)}: ${JSON.stringify(nested)}`);
    }
    open = next;
  }
  return inserted(
    text,
    open,
    key === null ? JSON.stringify(value) : `${JSON.stringify(key)}: ${JSON.stringify(value)}`,
  );
};

const deny = (draft: Draft, rule: string): void => {
  draft.text = appended(draft.text, DENY, null, rule);
  draft.json.permissions ??= {};
  (draft.json.permissions.deny ??= []).push(rule);
  draft.entries.push({ pointer: DENY_POINTER, value: rule });
};

// Removes the last occurrence.
const allow = (draft: Draft, rule: string): void => {
  const index = denied(draft).lastIndexOf(rule);
  const open = openAt(draft.text, DENY);
  if (open !== undefined) draft.text = removed(draft.text, open, index);
  denied(draft).splice(index, 1);
  draft.entries.push({ pointer: DENY_POINTER, value: rule });
};

const putPlugin = (draft: Draft, plugin: string, value: boolean): void => {
  const open = openAt(draft.text, [PLUGINS]);
  const member = open === undefined ? undefined : membersOf(draft.text, open).findLast((each) => each.key === plugin);
  draft.text =
    member === undefined
      ? appended(draft.text, [PLUGINS], plugin, value)
      : `${draft.text.slice(0, member.start)}${value}${draft.text.slice(member.end)}`;
  (draft.json.enabledPlugins ??= {})[plugin] = value;
};

const dropPlugin = (draft: Draft, plugin: string): void => {
  const open = openAt(draft.text, [PLUGINS]);
  if (open !== undefined) {
    const index = membersOf(draft.text, open).findLastIndex((each) => each.key === plugin);
    draft.text = removed(draft.text, open, index);
  }
  if (draft.json.enabledPlugins !== undefined) Reflect.deleteProperty(draft.json.enabledPlugins, plugin);
};

const pluginValue = (draft: Draft, plugin: string): unknown =>
  Object.hasOwn(draft.json.enabledPlugins ?? {}, plugin) ? draft.json.enabledPlugins?.[plugin] : undefined;

// A rule not in the array is added; one there is the app's, or the owner's and reported.
const rulesOff = (draft: Draft, rules: readonly string[]): void => {
  for (const rule of rules) {
    if (!denied(draft).includes(rule)) deny(draft, rule);
    else if (owned(draft, DENY_POINTER, rule) === undefined) ownerEntry(draft, rule);
  }
};

// An absent entry is written; the owner's true is changed to false, recording what it replaced.
const pluginOff = (draft: Draft, plugin: string): void => {
  const pointer = pointerOf(plugin);
  const value = pluginValue(draft, plugin);
  if (value === undefined || value === true) {
    putPlugin(draft, plugin, false);
    draft.entries.push(value === true ? { pointer, value: false, before: true } : { pointer, value: false });
    if (value === true) ownerEntry(draft, pointer, false);
  } else if (value !== false || owned(draft, pointer) === undefined) ownerEntry(draft, pointer);
};

// The last occurrence of an owned rule goes; an owned rule that is missing, and a copy that stays, are reported.
const rulesOn = (draft: Draft, rules: readonly string[]): void => {
  for (const rule of rules) {
    const mine = owned(draft, DENY_POINTER, rule) !== undefined;
    const present = denied(draft).includes(rule);
    if (mine && present) allow(draft, rule);
    if ((mine && !present) || denied(draft).includes(rule)) ownerEntry(draft, rule);
  }
};

// An owned false goes, or turns back into the true it replaced; any other value, and the owner's false, are reported.
const pluginOn = (draft: Draft, plugin: string): void => {
  const pointer = pointerOf(plugin);
  const mine = owned(draft, pointer);
  const off = pluginValue(draft, plugin) === false;
  if (mine === undefined || !off) {
    if (mine !== undefined || off) ownerEntry(draft, pointer);
    return;
  }
  if (mine.before === true) {
    putPlugin(draft, plugin, true);
    draft.entries.push({ pointer, value: true, before: false });
  } else {
    dropPlugin(draft, plugin);
    draft.entries.push({ pointer, value: false });
  }
};

const parsed = (text: string): unknown => {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
};

// The draft's text must read as exactly the changed settings, so a text the scan misread is never written.
const finished = (draft: Draft, created: boolean): Switched | undefined => {
  const { entries, skipped } = draft;
  if (entries.length === 0) return { text: null, entries, skipped };
  const expected = JSON.stringify(draft.json);
  if (JSON.stringify(parsed(draft.text)) !== expected) return undefined;
  return { text: created ? `${JSON.stringify(draft.json, null, 2)}\n` : draft.text, entries, skipped };
};

// Whether each key on the path occurs once in its object, so no reader can take another occurrence than the edit.
const unique = (text: string, keys: readonly string[]): boolean =>
  keys.every((key, depth) => {
    const open = openAt(text, keys.slice(0, depth));
    return open === undefined || membersOf(text, open).filter((each) => each.key === key).length < 2;
  });

const switched = (
  { text, path }: SettingsText,
  records: readonly SwitchRecord[],
  target: SwitchTarget,
  change: (draft: Draft) => void,
): Switched | undefined => {
  const source = text ?? '{}';
  const json = parsed(source);
  if (!isSettings(json) || !unique(source, 'rules' in target ? DENY : [PLUGINS, target.plugin])) return undefined;
  const draft: Draft = { text: source, json, entries: [], skipped: [], path, records };
  change(draft);
  return finished(draft, text === null);
};

/**
 * Switches off in a settings file: appends each deny rule that is missing, or sets the plugin entry to false. Records
 * come newest first. Undefined when the file is not a JSON object, its permissions, deny or enabledPlugins has
 * another type, a key on the edited path occurs twice in its object, or the edited text would not read back as the
 * change.
 */
export const switchedOff = (
  settings: SettingsText,
  records: readonly SwitchRecord[],
  target: SwitchTarget,
): Switched | undefined =>
  switched(settings, records, target, (draft) =>
    'rules' in target ? rulesOff(draft, target.rules) : pluginOff(draft, target.plugin),
  );

/** Switches back on what the app switched off and still owns; undefined as for switchedOff. */
export const switchedOn = (
  settings: SettingsText,
  records: readonly SwitchRecord[],
  target: SwitchTarget,
): Switched | undefined =>
  switched(settings, records, target, (draft) =>
    'rules' in target ? rulesOn(draft, target.rules) : pluginOn(draft, target.plugin),
  );
