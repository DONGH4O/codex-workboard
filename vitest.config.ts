import { configDefaults, defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    exclude: [...configDefaults.exclude, 'dist-electron/**', 'dist-renderer/**'],
    server: {
      deps: {
        external: ['node:sqlite'],
      },
    },
  },
});
