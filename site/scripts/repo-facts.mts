/** The facts the navbar's repository widget shows. Each is absent when GitHub did not give it. */
export interface RepoFacts {
  tag?: string;
  stars?: number;
  forks?: number;
}

/** The widget's own request, the build's `fetch` unless a test passes one. */
type Fetch = (url: string, init: RequestInit) => Promise<Response>;

/**
 * Stars, forks and the latest release tag (else the newest tag) of a GitHub repository, read at
 * build time so the site makes no request to GitHub from the browser. Any failure (offline, rate
 * limit, timeout) leaves that fact out and never fails the build. `token` lifts the anonymous
 * rate limit.
 */
export async function repoFacts(
  repo: string,
  token = process.env.GITHUB_TOKEN,
  request: Fetch = fetch,
): Promise<RepoFacts> {
  const get = async (path: string): Promise<unknown> => {
    const response = await request(`https://api.github.com/repos/${repo}${path}`, {
      headers: {
        Accept: 'application/vnd.github+json',
        ...(token && { Authorization: `Bearer ${token}` }),
      },
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) throw new Error(`${path}: ${response.status}`);
    return response.json();
  };
  const latestTag = async (): Promise<unknown> => {
    try {
      return field(await get('/releases/latest'), 'tag_name');
    } catch {
      return field(field(await get('/tags'), '0'), 'name');
    }
  };
  const [info, tag] = await Promise.all([get('').catch(() => undefined), latestTag().catch(() => undefined)]);
  const stars = field(info, 'stargazers_count');
  const forks = field(info, 'forks_count');
  const facts: RepoFacts = {};
  if (typeof tag === 'string') facts.tag = tag;
  if (typeof stars === 'number') facts.stars = stars;
  if (typeof forks === 'number') facts.forks = forks;
  return facts;
}

/** The own property `key` of a JSON value, an array index included; absent on anything else. */
function field(value: unknown, key: string): unknown {
  return typeof value === 'object' && value !== null ? Object.getOwnPropertyDescriptor(value, key)?.value : undefined;
}
