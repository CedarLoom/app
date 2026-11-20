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

const inside = (base: string, real: string): boolean => {
  const inner = relative(base, real);
  return inner !== '..' && !inner.startsWith(`..${sep}`) && !isAbsolute(inner);
};

/** The bytes of the file at `path` under `root`'s folder `scope`, links followed, when it stays inside both; null otherwise. */
const readInside = async (root: string, scope: string, path: string): Promise<Buffer | null> => {
  if (path.includes('\0')) return null;
  try {
    const [top, base, real] = await Promise.all([
      realpath(root),
      realpath(resolve(root, scope)),
      realpath(resolve(root, scope, path)),
    ]);
    if (!inside(top, real) || !inside(base, real)) return null;
    return await readFile(real);
  } catch (error) {
    if (absent(error)) return null;
    throw error;
  }
};

/** GET / answers with `root`'s index.html and GET /assets/* with the files in its assets folder; any other path gets 404. */
export const uiRoutes = (app: FastifyInstance, root: string): void => {
  const send = async (reply: FastifyReply, scope: string, path: string): Promise<FastifyReply> => {
    const bytes = await readInside(root, scope, path);
    if (bytes === null) {
      reply.callNotFound();
      return reply;
    }
    return reply.type(TYPES[extname(path)] ?? 'application/octet-stream').send(bytes);
  };
  // Files, not API routes: the OpenAPI document leaves them out.
  const schema = { hide: true };
  app.get('/', { schema }, (_req, reply) => send(reply, '.', 'index.html'));
  app.get<{ Params: { '*': string } }>('/assets/*', { schema }, (req, reply) => send(reply, 'assets', req.params['*']));
};
