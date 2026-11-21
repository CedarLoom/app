import '@mantine/core/styles.css';
import { createTheme, MantineProvider } from '@mantine/core';
import { api } from './api.ts';
import { createRoot } from 'react-dom/client';
import { App } from './app.tsx';
import { openSession } from './session.ts';

// An interim palette around the brand evergreen #2e5e4e as shade 7, the shade that fills use.
const theme = createTheme({
  colors: {
    evergreen: [
      '#eef6f3',
      '#dcebe5',
      '#b6d6ca',
      '#8dc0ad',
      '#6aad95',
      '#54a186',
      '#3f8a70',
      '#2e5e4e',
      '#234a3d',
      '#17342a',
    ],
  },
  primaryColor: 'evergreen',
  primaryShade: 7,
});

createRoot(document.body.appendChild(document.createElement('div'))).render(
  <MantineProvider theme={theme}>
    <App session={() => openSession(api(), location, history)} />
  </MantineProvider>,
);
