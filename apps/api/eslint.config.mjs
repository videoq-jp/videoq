import { workspaceConfig } from '../../eslint.shared.mjs'

const databaseImports = [
  'drizzle-orm', 'drizzle-orm/**', '@better-auth/drizzle-adapter', '@better-auth/drizzle-adapter/**', 'pg', 'pg/**', '@neondatabase/**',
  '@langchain/cloudflare', '@langchain/cloudflare/**', '@cloudflare/**',
  '@videoq-jp/langchainjs-postgres', '@videoq-jp/langchainjs-postgres/**', 'pgvector', 'pgvector/**',
  '**/db/**', '**/persistence/d1/**', '**/persistence/postgres/**',
]
// The pure shared upload module has no router, schema or platform dependencies.
const pureImports = [
  '../../domain/*/*', '../../../../domain/*/*', '../../../../application/*', './contracts', './batches',
  '../../persistence/contracts/*', '../../application/*',
  '../media/learning-playback-service', './resource-service', './authorization-service', './playback-context', './transcript', './launch-service', './generation-ports', './management-ports', './materials-sync-ports',
  './catalog', './ports', './core', './policy', './errors', './upload-reconcile-service', '../tasks/service', './native-learning', './lms-authority', './lti-registration', './external-task-repository', './creation-idempotency', './video-read-repository', './lti-subject',
  '../../features/billing/catalog', '../persistence/contracts/chat-repository', '../persistence/contracts/scene-search',
  '@videoq/domain/*',
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
          group: ['langchain', 'langchain/**', '@langchain/*', '@langchain/**', '**/rag', '**/rag-*', '**/lib/conversation', '**/lib/conversation-*'],
          message: 'Tool definitions must remain independent of agent frameworks and answer state. Adapt them on the consumer side.',
        }],
      }],
    },
  },
  {
    files: [
      'src/domain/**/*.ts', 'src/features/**/*.ts', 'src/repositories/**/*.ts', 'src/persistence/contracts/**/*.ts',
      'src/lib/**/*.ts', 'src/middleware/**/*.ts', 'src/shared/**/*.ts', 'src/trpc/**/*.ts',
    ],
    rules: {
      'no-restricted-imports': ['error', {
        patterns: [{ group: databaseImports, message: databaseImportMessage }],
      }],
      'no-restricted-syntax': ['error', {
        selector: 'ImportExpression[source.value=/^(drizzle-orm($|\\/)|@better-auth\\/drizzle-adapter($|\\/)|pg($|\\/)|@neondatabase\\/|@langchain\\/cloudflare($|\\/)|@videoq-jp\\/langchainjs-postgres($|\\/)|pgvector($|\\/)|@cloudflare\\/)|\\/(db|persistence\\/(d1|postgres))\\//]',
        message: databaseImportMessage,
      }],
    },
  },
  {
    files: [
      'src/application/**/*.ts', 'src/features/*/use-cases/**/*.ts', 'src/features/account/service.ts', 'src/features/billing/cost-ledger.ts', 'src/features/chat/evidence-registry.ts', 'src/features/material-management/service.ts', 'src/features/course-reports/service.ts', 'src/features/lti/operation-policy.ts',
      'src/features/worker-internal/{transcription,reindex}-service.ts',
      'src/features/course-memberships/{core,ports}.ts', 'src/persistence/contracts/invitation-{create,read,write}-repository.ts', 'src/features/course-memberships/delivery-service.ts', 'src/persistence/contracts/invitation-delivery-repository.ts', 'src/features/evidence/*-service.ts', 'src/features/classroom/{authorization,workflow}-service.ts', 'src/features/lti/session-service.ts', 'src/features/chat/execution-service.ts', 'src/features/lms/privacy-authorization-service.ts', 'src/features/lms/materials-sync-{service,ports}.ts', 'src/features/lms/native-session-policy.ts', 'src/features/course-reports/policy.ts', 'src/features/course-history/service.ts', 'src/features/course-history/policy.ts', 'src/features/course-tags/policy.ts', 'src/features/material-management/policy.ts', 'src/features/maintenance/{service,policy,ports,upload-reconcile-service,audit-retention-service,idempotency-retention-service,visual-object-service,scene-index-service}.ts', 'src/features/tasks/{service,ports}.ts', 'src/persistence/contracts/external-task-repository.ts', 'src/features/lti/registration-service.ts', 'src/persistence/contracts/lti-registration-repository.ts', 'src/features/lti/course-access-service.ts', 'src/persistence/contracts/linked-learning-repository.ts', 'src/features/lti/launch-service.ts', 'src/features/lti/learning-service.ts', 'src/features/lti/credential-service.ts', 'src/persistence/contracts/credential-repository.ts', 'src/features/media/core.ts', 'src/features/tags/core.ts', 'src/features/admin/core.ts', 'src/features/lms/native-learning-service.ts', 'src/persistence/contracts/native-session-repository.ts',
      'src/features/media/learning-playback-service.ts', 'src/features/lms/materials-snapshot-policy.ts', 'src/features/lms/installation-service.ts', 'src/features/lms/native-teacher-service.ts', 'src/features/lms/resource-service.ts', 'src/features/lms/pairing-service.ts', 'src/persistence/contracts/moodle-pairing-repository.ts',
      'src/features/qa/core.ts', 'src/features/teaching/core.ts', 'src/features/lms/upload-service.ts',
      'src/features/chat/{citation-policy,answer-content-service,answer-text-service}.ts', 'src/features/chat/generation-{service,ports}.ts',
      'src/features/videos/management-{service,ports}.ts',
      'src/features/membership/core.ts', 'src/features/billing/account-deletion-service.ts',
      'src/features/videos/upload-service.ts', 'src/features/courses/service.ts',
      'src/features/chat/service.ts', 'src/features/chat/conversation-service.ts',
      'src/features/billing/service.ts', 'src/features/billing/ports.ts', 'src/features/billing/catalog.ts',
      'src/persistence/contracts/{media-repository,tag-repository,ai-quota,membership-repository,qa-repository,billing-repository,course-repository,conversation-read,chat-repository,lti-subject,creation-idempotency,video-read-repository,video-upload-repository,video-mutation-repository,multipart-upload-repository}.ts',
      'src/lib/srt.ts', 'src/lib/transcript-quality.ts', 'src/features/lti/transcript.ts', 'src/features/lti/playback-context.ts',
      'src/lib/share-slug.ts',
    ],
    rules: {
      'no-restricted-imports': ['error', {
        patterns: [{ regex: pureImportRestriction,
          message: 'Application workflows and their contracts may depend only on pure contracts, policies and helpers; compose runtime adapters in integrations.' }],
      }],
      'no-restricted-syntax': ['error',
        { selector: 'NewExpression[callee.name="Date"][arguments.length=0]', message: 'Supply operation time or inject a clock from the runtime adapter.' },
        { selector: 'CallExpression[callee.object.name="Date"][callee.property.name="now"]', message: 'Inject a clock from the runtime adapter.' },
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
  {
    files: ['src/application/**/*.ts', 'src/persistence/contracts/**/*.ts'],
    rules: {
      'no-restricted-imports': ['error', { patterns: [{
        regex: '^(?!(?:\\./[^/]+|\\.\\./\\.\\./application/[^/]+|(?:\\.\\./){1,2}domain/[^/]+/[^/]+|@videoq/domain/[^/]+)$)',
        message: 'Application models and persistence ports must depend only on application models, other ports and shared domain policies.',
      }] }],
      'no-restricted-syntax': ['error',
        { selector: 'NewExpression[callee.name="Date"][arguments.length=0]', message: 'Supply operation time or inject a clock from the runtime adapter.' },
        { selector: 'CallExpression[callee.object.name="Date"][callee.property.name="now"]', message: 'Inject a clock from the runtime adapter.' },
        { selector: 'ImportExpression', message: 'Application models and ports cannot load runtime implementations.' },
        { selector: 'TSImportType', message: 'Use explicit application contract imports.' },
        { selector: 'TSImportEqualsDeclaration', message: 'Use explicit application contract imports.' },
        { selector: 'CallExpression[callee.name="require"]', message: 'Application models and ports cannot load runtime implementations.' },
      ],
    },
  },

  {
    files: ['src/domain/**/*.ts'],
    rules: {
      'no-restricted-imports': ['error', { patterns: [{
        regex: '^(?!(?:\\./[^/]+|\\.\\./[^/]+/[^/]+|@videoq/domain/[^/]+)$)',
        message: 'Domain rules depend only on their own context, explicitly published domain policies and the shared kernel.',
      }] }],
      'no-restricted-syntax': ['error',
        { selector: 'NewExpression[callee.name="Date"][arguments.length=0]', message: 'Domain decisions require explicit operation time.' },
        { selector: 'CallExpression[callee.object.name="Date"][callee.property.name="now"]', message: 'Domain decisions require explicit operation time.' },
        { selector: 'ImportExpression', message: 'Domain rules cannot load adapters.' },
        { selector: 'TSImportType', message: 'Use explicit domain imports.' },
        { selector: 'CallExpression[callee.name="require"]', message: 'Domain rules cannot load adapters.' },
      ],
    },
  },
]
