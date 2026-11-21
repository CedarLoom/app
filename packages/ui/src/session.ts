import type { Api } from './api.ts';
import type { Answer } from './load.tsx';

/**
 * Opens the browser session: a `#t=` fragment holds the one-time token printed by cedarloom-app, which leaves the
 * address bar and history before it is exchanged for the session cookie; without one, or when the token is spent, the
 * cookie set before is asked. No other part of the address is read.
 */
export const openSession = async (
  client: Api,
  location: Location,
  history: History,
): Promise<Answer<{ csrf: string }>> => {
  const { hash } = location;
  if (!hash.startsWith('#t=')) return client.GET('/api/session');
  const url = new URL(location.href);
  url.hash = '';
  history.replaceState(null, '', url);
  const exchanged = await client.POST('/api/session', { body: { token: hash.slice('#t='.length) } });
  if (exchanged.response.ok) return exchanged;
  // The printed link opened a second time carries a spent token, while the cookie of its first opening still holds.
  const held = await client.GET('/api/session');
  return held.response.ok ? held : exchanged;
};
