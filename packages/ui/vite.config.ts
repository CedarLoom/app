import { defineConfig } from 'vite';

export default defineConfig({
  build: {
    // The polyfill would be the only script besides the entry; every browser the UI supports has modulepreload.
    modulePreload: { polyfill: false },
    rolldownOptions: {
      // Mantine marks its modules "use client" for React Server Components, which a browser bundle has no use for.
      onwarn: (warning, warn) => {
        if (warning.code !== 'MODULE_LEVEL_DIRECTIVE') warn(warning);
      },
    },
  },
});
