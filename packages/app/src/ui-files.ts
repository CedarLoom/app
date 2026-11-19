import { readFile, realpath } from 'node:fs/promises';
import { extname, isAbsolute, relative, resolve, sep } from 'node:path';
import type { FastifyInstance, FastifyReply } from 'fastify';

// The file types a UI build emits; any other file goes out as bytes, and nosniff keeps the browser from guessing.
const TYPES: Readonly<Record<string, string>> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
};

// A folder, or a name the file system cannot hold, is no file either.
const absent = (error: unknown): boolean =>
  error instanceof Error &&
  'code' in error &&
  ['ENOENT', 'ENOTDIR', 'EISDIR', 'ENAMETOOLONG'].includes(String(error.code));

/** The bytes of the file at `path` under `root`, links followed, when it stays inside root; null otherwise. */
const readInside = async (root: string, path: string): Promise<Buffer | null> => {
  if (path.includes('\0')) return null;
  try {
    const [base, real] = await Promise.all([realpath(root), realpath(resolve(root, path))]);
    const inner = relative(base, real);
    if (inner === '..' || inner.startsWith(`..${sep}`) || isAbsolute(inner)) return null;
    return await readFile(real);
  } catch (error) {
    if (absent(error)) return null;
    throw error;
  }
};

/** GET / and GET /assets/* answer with the built UI's files in `root`; a missing file or one outside it gets 404. */
export const uiRoutes = (app: FastifyInstance, root: string): void => {
  const send = async (reply: FastifyReply, path: string): Promise<FastifyReply> => {
    const bytes = await readInside(root, path);
    if (bytes === null) {
      reply.callNotFound();
      return reply;
    }
    return reply.type(TYPES[extname(path)] ?? 'application/octet-stream').send(bytes);
  };
  // Files, not API routes: the OpenAPI document leaves them out.
  const schema = { hide: true };
  app.get('/', { schema }, (_req, reply) => send(reply, 'index.html'));
  app.get<{ Params: { '*': string } }>('/assets/*', { schema }, (req, reply) =>
    send(reply, `assets/${req.params['*']}`),
  );
};
