import { defineConfig, mergeConfig } from 'vitest/config';
import base from './vitest.config.js';

// Same suite against the TypeScript 7 backend (typescript-7 + ember-content-mapper).
export default mergeConfig(
  base,
  defineConfig({
    test: { env: { HVE_TS_BACKEND: 'tsgo' } },
  }),
);
