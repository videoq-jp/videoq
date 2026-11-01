import reactRefresh from 'eslint-plugin-react-refresh'
import { workspaceConfig } from '../../eslint.shared.mjs'
import { defineConfig, globalIgnores } from 'eslint/config'

export default defineConfig([
  ...workspaceConfig({ react: true, tsconfigRootDir: import.meta.dirname }),
  globalIgnores(['dist', 'coverage', 'storybook-static', 'test-results', '.wrangler', 'worker/env.d.ts', '.storybook/public/mockServiceWorker.js']),
  {
    files: ['**/*.{ts,tsx}'],
    extends: [
      reactRefresh.configs.vite,
    ],
  },
  {
    files: ['src/**/*.{ts,tsx}'],
    ignores: ['src/App.tsx', 'src/components/layout/**', '**/__tests__/**', '**/*.test.*', '**/*.spec.*', '**/*.stories.*'],
    rules: {
      'no-restricted-imports': ['error', {
        patterns: [{
          group: ['**/AppNav', '**/AppNav.*', '**/AppFooter', '**/AppFooter.*', '**/AppPageShell', '**/AppPageShell.*', '**/AuthLayout', '**/AuthLayout.*', '**/AuthPageFooter', '**/AuthPageFooter.*', '**/AppRouteLayout', '**/AppRouteLayout.*', '**/RouteContent', '**/RouteContent.*'],
          message: 'Layouts belong to parent routes in App.tsx. Pages must render content only so loading and errors cannot remove navigation.',
        }],
      }],
    },
  },
  {
    files: ['**/*.stories.{ts,tsx}', '.storybook/**/*.{ts,tsx}'],
    rules: {
      'react-refresh/only-export-components': 'off',
    },
  },
  {
    // UI utility modules often export helpers/constants alongside components
    files: ['src/components/ui/**/*.{ts,tsx}'],
    rules: {
      'react-refresh/only-export-components': 'off',
    },
  },
  {
    files: [
      '**/__tests__/**/*.{ts,tsx}',
      '**/*.{test,spec}.{ts,tsx}',
    ],
    languageOptions: {
      globals: {
        // Vitest globals (we run with `globals: true` in vitest config)
        vi: 'readonly',
        describe: 'readonly',
        it: 'readonly',
        test: 'readonly',
        expect: 'readonly',
        beforeAll: 'readonly',
        beforeEach: 'readonly',
        afterAll: 'readonly',
        afterEach: 'readonly',
      },
    },
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
    },
  },
  {
    files: ['vitest.setup.ts'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
    },
  },
])
