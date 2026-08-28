import { defineConfig } from 'vitest/config';

// Vitest's default test glob walks the whole project root, including
// `ecosystem/.cache/<repo>/` where ecosystem CI clones third-party repos.
// Those repos carry their own *.test.ts files for *their* test suites.
export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    exclude: ['**/node_modules/**', 'dist', 'ecosystem/**'],
    env: { HVE_TS_BACKEND: 'ts6' },
  },
});
