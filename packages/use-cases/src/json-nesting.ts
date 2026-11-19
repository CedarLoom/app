const QUOTE = 0x22;
const BACKSLASH = 0x5c;
const OPENING = new Set([0x5b, 0x7b]);
const CLOSING = new Set([0x5d, 0x7d]);

/** Whether JSON text nests arrays and objects deeper than limit; a loop over its bytes, so no depth can overflow it. */
export const nestsBeyond = (bytes: Uint8Array, limit: number): boolean => {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (const byte of bytes) {
    if (inString) {
      if (escaped) escaped = false;
      else if (byte === BACKSLASH) escaped = true;
      else if (byte === QUOTE) inString = false;
    } else if (byte === QUOTE) inString = true;
    else if (OPENING.has(byte)) {
      depth += 1;
      if (depth > limit) return true;
    } else if (CLOSING.has(byte)) depth -= 1;
  }
  return false;
};
