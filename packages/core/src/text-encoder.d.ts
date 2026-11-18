// The WHATWG Encoding API, which Node.js and browsers both provide and lib es2025 does not declare.
declare class TextEncoder {
  encode(input?: string): Uint8Array<ArrayBuffer>;
}
