import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({ test: {
  include: [fileURLToPath(new URL('../fixtures/ownership-result.fixture.mjs', import.meta.url))],
  maxWorkers: 1,
} });
