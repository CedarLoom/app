import createClient, { type Client } from 'openapi-fetch';
import type { paths } from './openapi.d.ts';

/** A client of the app's server, typed by its OpenAPI document. */
export type Api = Client<paths>;

/** A client that sends `headers` with each request to the server the page came from. */
export const api = (headers: Readonly<Record<string, string>> = {}): Api => createClient<paths>({ headers });
