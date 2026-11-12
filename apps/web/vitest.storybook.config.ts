import { fileURLToPath } from 'node:url';
import { defineProject } from 'vitest/config';
import { playwright } from '@vitest/browser-playwright';
import { storybookTest } from '@storybook/addon-vitest/vitest-plugin';
import previewViteConfig from './.storybook/vite.config.ts';

export default defineProject({
  resolve: previewViteConfig.resolve,
  define: previewViteConfig.define,
  // Prebundle runtimes, charts and DnD before browser tests start to avoid a mid-run reload.
  optimizeDeps: { include: ['react/jsx-dev-runtime', 'react-dom', '@tanstack/react-query-devtools', 'recharts', '@dnd-kit/core', '@dnd-kit/sortable', '@dnd-kit/utilities'] },
  plugins: [
    storybookTest({ configDir: fileURLToPath(new URL('./.storybook', import.meta.url)) }),
    {
      // Storybook 10.6 decodes spaces only when comparing a browser URL with
      // Vitest's filesystem path. Japanese workspace names otherwise skip every test.
      name: 'storybook-unicode-test-path',
      enforce: 'post',
      transform(code, id) {
        if (!/\.stories\.tsx?(?:\?|$)/.test(id)) return;
        return code.replace('convertToFilePath(import.meta.url)', 'convertToFilePath(decodeURI(import.meta.url))');
      },
    },
  ],
  test: {
    name: 'storybook',
    // Each worker owns a Chromium page; cap cold Vite imports and media decoding.
    maxWorkers: 2,
    browser: {
      enabled: true,
      headless: true,
      provider: playwright(),
      instances: [{ browser: 'chromium' }],
    },
  },
});
