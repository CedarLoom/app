import { themes as prismThemes } from 'prism-react-renderer';
import type { Config } from '@docusaurus/types';
import type * as Preset from '@docusaurus/preset-classic';
import { repoFacts } from './scripts/repo-facts.mts';

const slug = 'CedarLoom/app';
const repo = `https://github.com/${slug}`;

const footer: Preset.ThemeConfig['footer'] = {
  links: [
    {
      title: 'Project',
      items: [
        { label: 'README', href: `${repo}#readme` },
        { label: 'Development', href: `${repo}/blob/main/AGENTS.md` },
        { label: 'License', href: `${repo}/blob/main/LICENSE` },
      ],
    },
    {
      title: 'CedarLoom',
      items: [{ label: 'The plugins', href: 'https://cedarloom.github.io/cedarloom/' }],
    },
  ],
  copyright: 'Code and docs under the MIT license. The CedarLoom name and logos are not.',
};

const config = async (): Promise<Config> => ({
  title: 'CedarLoom app',
  tagline: 'Design, check and write the workflow definitions of a project for the CedarLoom plugins.',
  favicon: 'cedarloom-icon.svg',
  future: { v4: true },
  url: 'https://cedarloom.github.io',
  // BASE_URL serves a pull request preview from its own folder (.github/workflows/preview.yml).
  baseUrl: process.env.BASE_URL ?? '/app/',
  organizationName: 'CedarLoom',
  projectName: 'app',
  trailingSlash: false,
  onBrokenLinks: 'throw',
  onBrokenAnchors: 'throw',
  markdown: { hooks: { onBrokenMarkdownLinks: 'throw' } },
  // The logos stay in brand/ under their own terms; the site serves them from there.
  staticDirectories: ['static', '../brand'],
  i18n: { defaultLocale: 'en', locales: ['en'] },
  presets: [
    [
      'classic',
      {
        docs: { routeBasePath: '/', sidebarPath: './sidebars.ts' },
        blog: false,
        theme: { customCss: './src/css/custom.css' },
      } satisfies Preset.Options,
    ],
  ],
  themeConfig: {
    image: 'cedarloom-light-1280x640.png',
    colorMode: { respectPrefersColorScheme: true },
    navbar: {
      title: 'CedarLoom app',
      logo: { alt: '', src: 'cedarloom-icon.svg' },
      items: [
        { to: '/cli', label: 'Command line', position: 'left' },
        { to: '/web-ui', label: 'Web UI', position: 'left' },
        // Read once per build: the browser makes no request to GitHub.
        { type: 'custom-repo', repo: slug, facts: await repoFacts(slug), position: 'right' },
      ],
    },
    footer,
    prism: { theme: prismThemes.github, darkTheme: prismThemes.dracula },
  } satisfies Preset.ThemeConfig,
});

export default config;
