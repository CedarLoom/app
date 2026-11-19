import { join } from 'node:path';
import type { Finding } from '@cedarloom/core';
import { z } from 'zod';
import { jsonFile } from './json-file.ts';
import { PLUGIN_ID } from './plugin-locator.ts';

const Settings = z.looseObject({ enabledPlugins: z.record(z.string(), z.unknown()).optional() });

const disabled = (path: string | null): Finding => ({ code: 'plugin.disabled', severity: 'warning', params: { path } });

/** Why cl-workflow@cedarloom does not load: the highest of the local, project and user settings that names it does not enable it, or none names it. */
export const enabledFinding = (project: string | undefined, configDir: string): Finding | undefined => {
  const own =
    project === undefined ? [] : ['settings.local.json', 'settings.json'].map((name) => join(project, '.claude', name));
  for (const path of [...own, join(configDir, 'settings.json')]) {
    const read = jsonFile(path, Settings, { code: 'settings.unreadable', severity: 'error', params: { path } });
    if ('finding' in read) return read.finding;
    const plugins = read.value?.enabledPlugins;
    if (plugins === undefined || !Object.hasOwn(plugins, PLUGIN_ID)) continue;
    return plugins[PLUGIN_ID] === true ? undefined : disabled(path);
  }
  return disabled(null);
};
