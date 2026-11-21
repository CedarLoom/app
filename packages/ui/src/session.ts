import type { Refusal } from '@cedarloom/core';
import type { Api } from './api.ts';

export type Opened = { csrf: string } | { refusal: Refusal };

/**
 * Opens the browser session: a `#t=` fragment holds the one-time token printed by cedarloom-app, which leaves the
 * address bar and history before it is exchanged for the session cookie; without one, the cookie set before is asked.
 * No other part of the address is read.
 */
export const openSession = async (client: Api, location: Location, history: History): Promise<Opened> => {
  const { hash } = location;
  if (hash.startsWith('#t=')) {
    const url = new URL(location.href);
    url.hash = '';
    history.replaceState(null, '', url);
  }
  const { data, error } = hash.startsWith('#t=')
    ? await client.POST('/api/session', { body: { token: hash.slice('#t='.length) } })
    : await client.GET('/api/session');
  if (data !== undefined) return { csrf: data.csrf };
  return { refusal: error };
};
