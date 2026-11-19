import { workspaceConfig } from '../../eslint.shared.mjs'

const databaseImports = [
  'drizzle-orm', 'drizzle-orm/**', '@better-auth/drizzle-adapter', '@better-auth/drizzle-adapter/**', 'pg', 'pg/**', '@neondatabase/**',
  '@langchain/cloudflare', '@langchain/cloudflare/**', '@cloudflare/**',
  '@yukiharada1228/langchain-postgres', '@yukiharada1228/langchain-postgres/**', 'pgvector', 'pgvector/**',
  '**/db/**', '**/persistence/d1/**', '**/persistence/postgres/**',
]
// The pure shared upload module has no router, schema or platform dependencies.
const pureImports = [
  '../../persistence/contracts/*', '../../application/*',
  '../../lib/upload', '../../lib/share-slug', '../../shared/csv', '../../lib/youtube',
  './generation-ports', './management-ports',
  './catalog', './ports', './core', './creation-idempotency', './video-read-repository', './lti-subject',
  '../../features/billing/catalog', '../persistence/contracts/chat-repository',
  '@videoq/trpc/video-upload',
]
const pureImportRestriction = `^(?!(?:${pureImports.map(path => path.split('*').map(part => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('[^/]+')).join('|')})$)`

const databaseImportMessage = 'Shared business code must use persistence contracts and factories; database SDKs, schemas and adapters belong to persistence implementations.'

export default [
  ...workspaceConfig({ react: false, tsconfigRootDir: import.meta.dirname }),
  {
    files: ['src/tools/**/*.ts'],
    rules: {
      'no-restricted-imports': ['error', {
        patterns: [{
          group: ['langchain', 'langchain/**', '@langchain/*', '@langchain/**', '**/rag', '**/rag-*', '**/conversation', '**/conversation-*'],
          message: 'Tool definitions must remain independent of agent frameworks and answer state. Adapt them on the consumer side.',
        }],
      }],
    },
  },
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
  {
    files: [
      'src/application/**/*.ts',
      'src/features/qa/policy.ts', 'src/features/qa/core.ts', 'src/features/teaching/core.ts', 'src/features/lms/upload-service.ts',
      'src/features/chat/generation-{service,ports}.ts',
      'src/features/videos/management-{service,ports}.ts',
      'src/features/membership/core.ts', 'src/features/billing/account-deletion-service.ts',
      'src/features/videos/upload-service.ts', 'src/features/courses/service.ts',
      'src/features/chat/service.ts', 'src/features/chat/conversation-service.ts',
      'src/features/billing/service.ts', 'src/features/billing/ports.ts', 'src/features/billing/catalog.ts',
      'src/persistence/contracts/{ai-quota,membership-repository,qa-repository,billing-repository,course-repository,conversation-read,chat-repository,lti-subject,creation-idempotency,video-read-repository,video-upload-repository,video-mutation-repository,multipart-upload-repository}.ts',
      'src/lib/upload.ts', 'src/lib/share-slug.ts', 'src/shared/csv.ts', 'src/lib/youtube.ts',
    ],
    rules: {
      'no-restricted-imports': ['error', {
        patterns: [{ regex: pureImportRestriction,
          message: 'Application workflows and their contracts may depend only on pure contracts, policies and helpers; compose runtime adapters in integrations.' }],
      }],
      'no-restricted-syntax': ['error',
        { selector: 'ImportExpression', message: 'Inject capabilities instead of loading implementations in a use case.' },
        { selector: 'TSImportType', message: 'Use explicit contract imports so the dependency boundary is checked.' },
        { selector: 'TSImportEqualsDeclaration', message: 'Use explicit contract imports so the dependency boundary is checked.' },
        { selector: 'CallExpression[callee.name="require"]', message: 'Inject implementations instead of requiring them in application code.' },
      ],
    },
  },
  {
    files: ['src/features/qa/service.ts', 'src/persistence/contracts/qa-repository.ts'],
    rules: {
      'no-restricted-imports': ['error', {
        patterns: [{ regex: '^(?!(?:\\./core|\\.\\./\\.\\./persistence/contracts/qa-repository|\\.\\./\\.\\./application/lti-session-proof)$)',
          message: 'Q&A contracts and use cases must not depend on transport, runtime configuration or persistence implementations.' }],
      }],
      'no-restricted-syntax': ['error',
        { selector: 'ImportExpression', message: 'Inject implementations outside Q&A contracts and use cases.' },
        { selector: 'TSImportType', message: 'Use explicit contract imports so the dependency boundary is checked.' },
      ],
    },
  },
]
