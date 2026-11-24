import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';

// Install the browser used by Vitest's provider, even when npm hoists a
// different Playwright version from the workspace's direct dependency.
const require = createRequire(import.meta.url);
const providerRequire = createRequire(require.resolve('@vitest/browser-playwright'));
execFileSync(process.execPath, [
  join(dirname(providerRequire.resolve('playwright/package.json')), 'cli.js'),
  'install', ...process.argv.slice(2), 'chromium',
], { stdio: 'inherit' });
