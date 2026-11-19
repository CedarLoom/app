import { join } from 'node:path';
import type { Finding } from '@cedarloom/core';
import { z } from 'zod';
import { jsonFile } from './json-file.ts';

export const MARKETPLACE = 'cedarloom';
// GitHub resolves owner and repository names without regard to case.
const REPOSITORY = 'cedarloom/cedarloom';
const GIT_URLS = [
  /^https:\/\/github\.com\/([^/]+\/[^/]+?)(?:\.git)?\/?$/i,
  /^git@github\.com:([^/]+\/[^/]+?)(?:\.git)?$/i,
];

// Only the cedarloom entry is read, so another marketplace's shape never blocks the plugin.
const KnownMarketplaces = z.record(z.string(), z.unknown());
const Entry = z.looseObject({ source: z.looseObject({ source: z.string() }) });
const GitHubSource = z.looseObject({ source: z.literal('github'), repo: z.string() });
const GitSource = z.looseObject({ source: z.literal('git'), url: z.string() });
// The value the untrusted-marketplace finding names, by source form.
const NAMED_BY = ['repo', 'url', 'path', 'package'];

const repositoryOf = (source: unknown): string | undefined => {
  const github = GitHubSource.safeParse(source);
  if (github.success) return github.data.repo;
  const git = GitSource.safeParse(source);
  if (!git.success) return undefined;
  return GIT_URLS.map((pattern) => pattern.exec(git.data.url)?.[1]).find((repo) => repo !== undefined);
};

/** Why the cedarloom marketplace recorded in known_marketplaces.json is not the CedarLoom/cedarloom repository; undefined when it is. */
export const originFinding = (pluginsRoot: string): Finding | undefined => {
  const file = join(pluginsRoot, 'known_marketplaces.json');
  const unknown: Finding = { code: 'plugin.record-unknown', severity: 'error', params: { file } };
  const read = jsonFile(file, KnownMarketplaces, unknown);
  if ('finding' in read) return read.finding;
  const entry = Entry.safeParse(read.value?.[MARKETPLACE]);
  if (!entry.success) return unknown;
  const { source } = entry.data;
  const kind = source.source;
  if ((kind === 'github' || kind === 'git') && !GitHubSource.or(GitSource).safeParse(source).success) return unknown;
  if (repositoryOf(source)?.toLowerCase() === REPOSITORY) return undefined;
  const named = NAMED_BY.map((key) => source[key]).find((value) => typeof value === 'string');
  return {
    code: 'plugin.marketplace-untrusted',
    severity: 'error',
    params: { marketplace: MARKETPLACE, source: typeof named === 'string' ? named : kind },
  };
};
