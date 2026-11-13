import { workspaceConfig } from '../../eslint.shared.mjs'

const databaseImports = [
  'drizzle-orm', 'drizzle-orm/**', 'pg', 'pg/**', '@neondatabase/**',
  '@langchain/cloudflare', '@langchain/cloudflare/**', '@cloudflare/**',
  '@yukiharada1228/langchain-postgres', '@yukiharada1228/langchain-postgres/**', 'pgvector', 'pgvector/**',
  '**/db/**', '**/persistence/d1/**', '**/persistence/postgres/**',
]
const databaseImportMessage = 'Shared business code must use persistence contracts and factories; database SDKs, schemas and adapters belong to persistence implementations.'

export default [
  ...workspaceConfig({ react: false, tsconfigRootDir: import.meta.dirname }),
  {
    files: ['src/features/**/*.ts', 'src/repositories/**/*.ts', 'src/persistence/contracts/**/*.ts'],
    // This entrypoint provisions local PostgreSQL accounts using Better Auth.
    ignores: ['src/features/admin/onprem-users.ts'],
    rules: {
      'no-restricted-imports': ['error', {
        patterns: [{ group: databaseImports, message: databaseImportMessage }],
      }],
      'no-restricted-syntax': ['error', {
        selector: 'ImportExpression[source.value=/^(drizzle-orm($|\\/)|pg($|\\/)|@neondatabase\\/|@langchain\\/cloudflare($|\\/)|@yukiharada1228\\/langchain-postgres($|\\/)|pgvector($|\\/)|@cloudflare\\/)|\\/(db|persistence\\/(d1|postgres))\\//]',
        message: databaseImportMessage,
      }],
    },
  },
]
