import { cpSync, existsSync, rmSync } from 'node:fs';

// Replaces dist/ui with the ui package's build output; without one, dist/ui stays absent and the server answers 404.
const from = new URL('../../ui/dist/', import.meta.url);
// No trailing slash: with one, rmSync follows a linked dist/ui and empties the link's target.
const to = new URL('../dist/ui', import.meta.url);
rmSync(to, { recursive: true, force: true });
if (existsSync(from)) cpSync(from, to, { recursive: true, dereference: true });
