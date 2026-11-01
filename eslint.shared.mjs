import js from '@eslint/js'
import globals from 'globals'
import tseslint from 'typescript-eslint'
import reactHooks from 'eslint-plugin-react-hooks'
import { defineConfig, globalIgnores } from 'eslint/config'

// TypeScript's native `tsc` is used for checking; ESLint imports the TS 6 API.
export function workspaceConfig({ react = false, tsconfigRootDir } = {}) {
  return defineConfig([
    globalIgnores([
      'node_modules', 'dist', 'build', 'coverage', '.wrangler', '.docusaurus',
      'worker-configuration.d.ts', 'public', 'static', 'out',
    ]),
    { files: ['**/*.{js,mjs,cjs,ts,tsx}'], extends: [js.configs.recommended],
      languageOptions: { globals: { ...globals.node, ...globals.browser, ...globals.worker } } },
    { files: ['**/*.{ts,tsx}'], extends: [tseslint.configs.recommended],
      languageOptions: { parserOptions: { tsconfigRootDir } },
      rules: {
        // Underscore names explicitly mark unused callback inputs / omitted fields.
        '@typescript-eslint/no-unused-vars': ['error', {
          argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_',
        }],
      } },
    ...(react ? [{ files: ['**/*.{ts,tsx}'], extends: [reactHooks.configs.flat.recommended] }] : []),
    { files: ['**/*.{test,spec}.{ts,tsx}', '**/__tests__/**/*.{ts,tsx}', 'test/**/*.{ts,tsx}'],
      rules: { '@typescript-eslint/no-explicit-any': 'off' } },
  ])
}
