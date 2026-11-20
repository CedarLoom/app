// Positions in and edits of a text that JSON.parse accepts, which leave every other character as it was. The scans
// are loops, so a deep text does not overflow the stack.

/** An object member or array element: its key (null in an array), where it starts, and where its value starts and ends. */
export interface Member {
  key: string | null;
  from: number;
  start: number;
  end: number;
}

const WHITESPACE = new Set([' ', '\t', '\n', '\r']);
const CLOSERS = new Set(['}', ']', '']);

const skipped = (text: string, at: number): number => {
  let index = at;
  while (WHITESPACE.has(text.charAt(index))) index += 1;
  return index;
};

const stringEnd = (text: string, start: number): number => {
  let index = start + 1;
  while (index < text.length && text.charAt(index) !== '"') index += text.charAt(index) === '\\' ? 2 : 1;
  return index + 1;
};

const containerEnd = (text: string, start: number): number => {
  let depth = 0;
  let index = start;
  while (index < text.length) {
    const char = text.charAt(index);
    if (char === '"') {
      index = stringEnd(text, index);
      continue;
    }
    if (char === '{' || char === '[') depth += 1;
    if ((char === '}' || char === ']') && --depth === 0) return index + 1;
    index += 1;
  }
  return index;
};

const valueEnd = (text: string, start: number): number => {
  const first = text.charAt(start);
  if (first === '"') return stringEnd(text, start);
  if (first === '{' || first === '[') return containerEnd(text, start);
  let index = start;
  while (!CLOSERS.has(text.charAt(index)) && text.charAt(index) !== ',' && !WHITESPACE.has(text.charAt(index)))
    index += 1;
  return index;
};

/** The members of the object or array whose opening bracket is at `open`, in text order. */
export const membersOf = (text: string, open: number): Member[] => {
  const object = text.charAt(open) === '{';
  const members: Member[] = [];
  let index = skipped(text, open + 1);
  while (!CLOSERS.has(text.charAt(index))) {
    const from = index;
    let key: string | null = null;
    if (object) {
      const keyEnd = stringEnd(text, index);
      key = String(JSON.parse(text.slice(index, keyEnd)));
      index = skipped(text, skipped(text, keyEnd) + 1);
    }
    const end = valueEnd(text, index);
    members.push({ key, from, start: index, end });
    index = skipped(text, end);
    if (text.charAt(index) === ',') index = skipped(text, index + 1);
  }
  return members;
};

/** Where the value at the object keys starts, each found as JSON.parse reads it, by its last occurrence. */
export const openAt = (text: string, keys: readonly string[]): number | undefined => {
  let open = skipped(text, 0);
  for (const key of keys) {
    const member = membersOf(text, open).findLast((each) => each.key === key);
    if (member === undefined) return undefined;
    open = member.start;
  }
  return open;
};

/** The text with `item` after the last member of the container at `open`, joined as its first member is indented. */
export const inserted = (text: string, open: number, item: string): string => {
  const members = membersOf(text, open);
  const [first] = members;
  const last = members.at(-1);
  if (first === undefined || last === undefined) return `${text.slice(0, open + 1)}${item}${text.slice(open + 1)}`;
  const gap = text.slice(open + 1, first.from) || ' ';
  return `${text.slice(0, last.end)},${gap}${item}${text.slice(last.end)}`;
};

/** The text without the member at `index` of the container at `open` and the comma that joined it. */
export const removed = (text: string, open: number, index: number): string => {
  const members = membersOf(text, open);
  const [before, member, after] = [members[index - 1], members[index], members[index + 1]];
  if (member === undefined) return text;
  if (before !== undefined) return `${text.slice(0, before.end)}${text.slice(member.end)}`;
  if (after !== undefined) return `${text.slice(0, member.from)}${text.slice(after.from)}`;
  return `${text.slice(0, open + 1)}${text.slice(skipped(text, member.end))}`;
};
