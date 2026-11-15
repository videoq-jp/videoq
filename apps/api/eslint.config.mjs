import { workspaceConfig } from '../../eslint.shared.mjs'

const databaseImports = [
  'drizzle-orm', 'drizzle-orm/**', '@better-auth/drizzle-adapter', '@better-auth/drizzle-adapter/**', 'pg', 'pg/**', '@neondatabase/**',
  '@langchain/cloudflare', '@langchain/cloudflare/**', '@cloudflare/**',
  '@yukiharada1228/langchain-postgres', '@yukiharada1228/langchain-postgres/**', 'pgvector', 'pgvector/**',
  '**/db/**', '**/persistence/d1/**', '**/persistence/postgres/**',
]
const databaseImportMessage = 'Shared business code must use persistence contracts and factories; database SDKs, schemas and adapters belong to persistence implementations.'

export default [
  ...workspaceConfig({ react: false, tsconfigRootDir: import.meta.dirname }),
  {
    files: [
      'src/features/**/*.ts', 'src/repositories/**/*.ts', 'src/persistence/contracts/**/*.ts',
      'src/lib/**/*.ts', 'src/middleware/**/*.ts', 'src/shared/**/*.ts', 'src/trpc/**/*.ts',
    ],
    // This on-prem entrypoint provisions PostgreSQL users in one transaction.
    ignores: ['src/features/admin/onprem-users.ts'],
    rules: {
      'no-restricted-imports': ['error', {
        patterns: [{ group: databaseImports, message: databaseImportMessage }],
      }],
      'no-restricted-syntax': ['error', {
        selector: 'ImportExpression[source.value=/^(drizzle-orm($|\\/)|@better-auth\\/drizzle-adapter($|\\/)|pg($|\\/)|@neondatabase\\/|@langchain\\/cloudflare($|\\/)|@yukiharada1228\\/langchain-postgres($|\\/)|pgvector($|\\/)|@cloudflare\\/)|\\/(db|persistence\\/(d1|postgres))\\//]',
        message: databaseImportMessage,
      }],
    },
  },
]
