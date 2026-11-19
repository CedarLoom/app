import { join, resolve } from 'node:path';

export interface ClaudeDirInputs {
  env: Readonly<Record<string, string | undefined>>;
  home: string;
  cwd: string;
}

/** Claude Code's folder, which holds the user settings: CLAUDE_CONFIG_DIR, else .claude in the home folder. */
export const claudeConfigDir = ({ env, home, cwd }: ClaudeDirInputs): string => {
  const own = env['CLAUDE_CONFIG_DIR'];
  return own ? resolve(cwd, own) : join(home, '.claude');
};

/** The folder of installed_plugins.json and known_marketplaces.json: CLAUDE_CODE_PLUGIN_CACHE_DIR, else plugins in Claude Code's folder. */
export const pluginsRoot = (inputs: ClaudeDirInputs): string => {
  const own = inputs.env['CLAUDE_CODE_PLUGIN_CACHE_DIR'];
  return own ? resolve(inputs.cwd, own) : join(claudeConfigDir(inputs), 'plugins');
};
