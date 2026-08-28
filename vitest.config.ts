import { defineConfig } from 'vitest/config';

// `ecosystem/.cache` holds checkouts of real-world Ember repos used by the
// ecosystem runner; their own test files are not ours to run.
export default defineConfig({
  test: {
    exclude: ['**/node_modules/**', 'ecosystem/**'],
    env: { HVE_TS_BACKEND: 'ts6' },
  },
});
