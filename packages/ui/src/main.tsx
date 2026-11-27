import '@mantine/core/styles.css';
import './brand.css';
import {
  Anchor,
  type CSSVariablesResolver,
  createTheme,
  defaultVariantColorsResolver,
  MantineProvider,
  parseThemeColor,
  type VariantColorsResolver,
} from '@mantine/core';
import { api } from './api.ts';
import { createRoot } from 'react-dom/client';
import { App } from './app.tsx';
import { openSession } from './session.ts';

// The accent from brand/tokens.css, mixed toward white (0 to 5) and black (7 to 9) around shade 6, the shade that fills use.
const accent = (share: number, end: 'white' | 'black'): string =>
  `color-mix(in srgb, var(--cl-accent) ${share}%, ${end})`;
// Mantine's surface, text and link colors take the brand tokens in both schemes.
const tokens = {
  '--mantine-color-body': 'var(--cl-surface)',
  '--mantine-color-text': 'var(--cl-ink)',
  '--mantine-color-dimmed': 'var(--cl-ink-2)',
  '--mantine-color-error': 'var(--cl-danger)',
  '--mantine-color-anchor': 'var(--cl-ink)',
};
// Accent fills take the primary contrast color, which the dark scheme sets to the surface: white on its light accent is 2.1:1.
const variantColorResolver: VariantColorsResolver = (input) => {
  const colors = defaultVariantColorsResolver(input);
  const filledAccent =
    input.variant === 'filled' && parseThemeColor({ color: input.color, theme: input.theme }).color === 'accent';
  return filledAccent ? { ...colors, color: 'var(--mantine-primary-color-contrast)' } : colors;
};
const theme = createTheme({
  colors: {
    accent: [
      accent(10, 'white'),
      accent(20, 'white'),
      accent(35, 'white'),
      accent(50, 'white'),
      accent(70, 'white'),
      accent(85, 'white'),
      'var(--cl-accent)',
      accent(85, 'black'),
      accent(70, 'black'),
      accent(55, 'black'),
    ],
  },
  primaryColor: 'accent',
  primaryShade: 6,
  fontFamily: 'var(--cl-font-family)',
  headings: { fontFamily: 'var(--cl-font-family)', fontWeight: 'var(--cl-font-weight-strong)' },
  components: { Anchor: Anchor.extend({ defaultProps: { underline: 'always' } }) },
  variantColorResolver,
});
const cssVariablesResolver: CSSVariablesResolver = () => ({
  variables: {},
  light: tokens,
  dark: {
    ...tokens,
    // Mantine derives these from shade 9 with functions that read var(), hex, rgb or hsl colors, not color-mix().
    '--mantine-color-accent-light': 'color-mix(in srgb, var(--cl-accent) 15%, var(--cl-surface))',
    '--mantine-color-accent-light-hover': 'color-mix(in srgb, var(--cl-accent) 25%, var(--cl-surface))',
    '--mantine-primary-color-contrast': 'var(--cl-surface)',
  },
});

// A printed link pasted into a tab that shows the page changes only the fragment, which loads no page.
addEventListener('hashchange', () => {
  if (location.hash.startsWith('#t=')) location.reload();
});

createRoot(document.body.appendChild(document.createElement('div'))).render(
  <MantineProvider theme={theme} cssVariablesResolver={cssVariablesResolver} defaultColorScheme="auto">
    <App session={() => openSession(api(), location, history)} />
  </MantineProvider>,
);
