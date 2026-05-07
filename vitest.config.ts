import { defineConfig } from 'vitest/config';

// Vitest's default test glob (`**/*.{test,spec}.?(c|m)[jt]s?(x)`) walks the
// whole project root, including `ecosystem/.cache/<repo>/` where ecosystem
// CI clones third-party repos. Those repos carry their own *.test.ts files
// for *their* test suites; we must not run them.
export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    exclude: ['node_modules', 'dist', 'ecosystem/.cache'],
  },
});
