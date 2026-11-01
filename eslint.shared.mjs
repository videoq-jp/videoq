import js from '@eslint/js'
import globals from 'globals'
import tseslint from 'typescript-eslint'
import reactHooks from 'eslint-plugin-react-hooks'
import { defineConfig, globalIgnores } from 'eslint/config'

// TypeScript's native `tsc` is used for checking; ESLint imports the TS 6 API.
export function workspaceConfig({ react = false, tsconfigRootDir, project = './tsconfig.eslint.json' } = {}) {
  return defineConfig([
    globalIgnores([
      'node_modules', 'dist', 'build', 'coverage', '.wrangler', '.docusaurus',
      'worker-configuration.d.ts', 'public', 'static', 'out',
    ]),
    { files: ['**/*.{js,mjs,cjs,ts,tsx}'], extends: [js.configs.recommended],
      languageOptions: { globals: { ...globals.node, ...globals.browser, ...globals.worker } } },
    { files: ['**/*.{ts,tsx}'], extends: [tseslint.configs.recommendedTypeChecked],
      languageOptions: { parserOptions: { tsconfigRootDir, project } },
      rules: {
        // Underscore names explicitly mark unused callback inputs / omitted fields.
        '@typescript-eslint/no-unused-vars': ['error', {
          argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_',
        }],
      } },
    ...(react ? [{ files: ['**/*.{ts,tsx}'], extends: [reactHooks.configs.flat.recommended] }] : []),
    { files: ['**/*.{test,spec}.{ts,tsx}', '**/__tests__/**/*.{ts,tsx}', 'test/**/*.{ts,tsx}', 'type-tests/**/*.ts', '**/*.stories.{ts,tsx}', '.storybook/**/*.{ts,tsx}', 'vitest*.ts'],
      rules: {
        // Test doubles intentionally accept malformed data and expose methods for assertions.
        // Promise handling rules stay enabled, including in fixtures and stories.
        '@typescript-eslint/no-explicit-any': 'off',
        '@typescript-eslint/no-unsafe-assignment': 'off',
        '@typescript-eslint/no-unsafe-argument': 'off',
        '@typescript-eslint/no-unsafe-call': 'off',
        '@typescript-eslint/no-unsafe-member-access': 'off',
        '@typescript-eslint/no-unsafe-return': 'off',
        '@typescript-eslint/unbound-method': 'off',
        '@typescript-eslint/require-await': 'off',
      } },
  ])
}
