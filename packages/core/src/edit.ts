import type { JsonValue } from './canonical-json.ts';
import type { Refusal } from './finding.ts';

/**
 * A structural edit of a workflow definition, addressed by RFC 6901 JSON Pointers. add, move and remove take stage
 * positions, /stages/<i>, and phase positions, /stages/<i>/phases/<j>, with "-" for the end of the list in add and in
 * move's `to`, the position after the removal. set and unset take any member whose parent exists.
 */
export type Edit =
  | { operation: 'add'; pointer: string; value: JsonValue }
  | { operation: 'move'; from: string; to: string }
  | { operation: 'remove'; pointer: string }
  | { operation: 'set'; pointer: string; value: JsonValue }
  | { operation: 'unset'; pointer: string };

type JsonObject = { [key: string]: JsonValue };

// Where a stage or phase position points: the list it names and the token of its index.
interface Position {
  list: JsonValue[];
  token: string;
  depth: number;
}

const isObject = (value: JsonValue | undefined): value is JsonObject =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

// RFC 6901, section 4: "~1" stands for "/" and "~0" for "~", replaced in that order; any other "~" is no pointer.
const tokensOf = (pointer: string): string[] | undefined => {
  if (!pointer.startsWith('/')) return undefined;
  const tokens = pointer.slice(1).split('/');
  if (tokens.some((token) => /~(?![01])/.test(token))) return undefined;
  return tokens.map((token) => token.replaceAll('~1', '/').replaceAll('~0', '~'));
};

// RFC 6901, section 4: an array index has no sign and no leading zero.
const indexOf = (token: string): number | undefined => (/^(0|[1-9][0-9]*)$/.test(token) ? Number(token) : undefined);

// A member of an object or an element of an array that the value holds; a member it inherits is none.
const childOf = (value: JsonValue | undefined, token: string): JsonValue | undefined => {
  if (Array.isArray(value)) return value[indexOf(token) ?? value.length];
  return isObject(value) && Object.hasOwn(value, token) ? value[token] : undefined;
};

const positionOf = (definition: JsonValue, pointer: string): Position | undefined => {
  const tokens = tokensOf(pointer) ?? [];
  const [first, stage = '', second, phase = ''] = tokens;
  const stages = first === 'stages' ? childOf(definition, 'stages') : undefined;
  if (tokens.length === 2 && Array.isArray(stages)) return { list: stages, token: stage, depth: 2 };
  const phases = second === 'phases' ? childOf(childOf(stages, stage), 'phases') : undefined;
  return tokens.length === 4 && Array.isArray(phases) ? { list: phases, token: phase, depth: 4 } : undefined;
};

// The index of an element the list holds.
const heldAt = ({ list, token }: Position): number | undefined => {
  const index = indexOf(token);
  return index !== undefined && index < list.length ? index : undefined;
};

// The index an element goes to: one the list holds, or its end.
const insertAt = ({ list, token }: Position): number | undefined => {
  const index = token === '-' ? list.length : indexOf(token);
  return index !== undefined && index <= list.length ? index : undefined;
};

// The object or array that holds the member a pointer names, with the member's token.
const parentOf = (definition: JsonValue, pointer: string): { parent: JsonValue; token: string } | undefined => {
  const tokens = tokensOf(pointer);
  const token = tokens?.at(-1);
  // Assigning "__proto__" would set the object's prototype instead of a member.
  if (tokens === undefined || token === undefined || token === '__proto__') return undefined;
  let parent: JsonValue | undefined = definition;
  for (const each of tokens.slice(0, -1)) parent = childOf(parent, each);
  return parent === undefined ? undefined : { parent, token };
};

const add = (copy: JsonValue, pointer: string, value: JsonValue): boolean => {
  const position = positionOf(copy, pointer);
  const index = position === undefined ? undefined : insertAt(position);
  if (position === undefined || index === undefined) return false;
  position.list.splice(index, 0, value);
  return true;
};

const remove = (copy: JsonValue, pointer: string): boolean => {
  const position = positionOf(copy, pointer);
  const index = position === undefined ? undefined : heldAt(position);
  if (position === undefined || index === undefined) return false;
  position.list.splice(index, 1);
  return true;
};

// The pointer move cannot apply at, if any; a stage cannot become a phase, and a move onto itself changes nothing.
const move = (copy: JsonValue, from: string, to: string): string | undefined => {
  const source = positionOf(copy, from);
  const index = source === undefined ? undefined : heldAt(source);
  if (source === undefined || index === undefined) return from;
  const target = positionOf(copy, to);
  if (target === undefined || target.depth !== source.depth) return to;
  const [moved] = source.list.splice(index, 1);
  const at = insertAt(target);
  if (moved === undefined || at === undefined || (target.list === source.list && at === index)) return to;
  target.list.splice(at, 0, moved);
  return undefined;
};

// An object's member is set whether or not it exists; an array's element only in place of one it holds.
const set = (copy: JsonValue, pointer: string, value: JsonValue): boolean => {
  const place = parentOf(copy, pointer);
  if (place === undefined) return false;
  const { parent, token } = place;
  const index = indexOf(token);
  if (isObject(parent)) parent[token] = value;
  else if (Array.isArray(parent) && index !== undefined && index < parent.length) parent[index] = value;
  else return false;
  return true;
};

const unset = (copy: JsonValue, pointer: string): boolean => {
  const place = parentOf(copy, pointer);
  if (place === undefined || !isObject(place.parent) || !Object.hasOwn(place.parent, place.token)) return false;
  delete place.parent[place.token];
  return true;
};

// Changes the copy; the pointer the edit cannot apply at, if any.
const invalidIn = (copy: JsonValue, edit: Edit): string | undefined => {
  if (edit.operation === 'move') return move(copy, edit.from, edit.to);
  if (edit.operation === 'add') return add(copy, edit.pointer, edit.value) ? undefined : edit.pointer;
  if (edit.operation === 'set') return set(copy, edit.pointer, edit.value) ? undefined : edit.pointer;
  const applied = edit.operation === 'remove' ? remove(copy, edit.pointer) : unset(copy, edit.pointer);
  return applied ? undefined : edit.pointer;
};

// Object.fromEntries defines each member, so a "__proto__" member stays a member.
const copyOf = (value: JsonValue): JsonValue => {
  if (Array.isArray(value)) return value.map(copyOf);
  return isObject(value) ? Object.fromEntries(Object.entries(value).map(([key, each]) => [key, copyOf(each)])) : value;
};

/** The definition with the edit applied, or `edit.target-invalid` naming the pointer it cannot apply at. */
export const edited = (definition: JsonValue, edit: Edit): { definition: JsonValue } | { refusal: Refusal } => {
  const copy = copyOf(definition);
  const invalid = invalidIn(copy, edit);
  if (invalid === undefined) return { definition: copy };
  return { refusal: { code: 'edit.target-invalid', params: { pointer: invalid, operation: edit.operation } } };
};
