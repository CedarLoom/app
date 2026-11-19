import { writeFileSync } from 'node:fs';
import { buildServer } from '../src/server.ts';
import { Session } from '../src/session.ts';

// Writes the OpenAPI document of the server's routes; building the server reads no project, so the inputs are blank.
const session = new Session({ now: () => 0, secret: () => '' });
const clock = { now: () => new Date(0), newRunId: () => '' };
const project = { root: '', storeDir: '', clock, node: '', required: '', cwd: '', env: {}, home: '', pluginRoot: null };
const app = await buildServer({ session, log: () => undefined, project, ui: '' });
await app.ready();
// fastify-type-provider-zod refers into __shared with a second '#', which no JSON Pointer resolves.
const document = JSON.stringify(app.swagger()).replaceAll('/__shared#/$defs/', '/__shared/$defs/');
writeFileSync(new URL('../openapi.json', import.meta.url), document);
await app.close();
