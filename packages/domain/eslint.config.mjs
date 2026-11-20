import { workspaceConfig } from '../../eslint.shared.mjs'

export default [
  ...workspaceConfig({ react: false, tsconfigRootDir: import.meta.dirname }),
  {
    files: ['src/**/*.ts'],
    rules: {
      'no-restricted-imports': ['error', { patterns: [{ regex: '^(?!\\.)', message: 'Domain policies must not depend on frameworks, transport or runtime packages.' }] }],
      'no-restricted-syntax': ['error',
        { selector: 'ImportExpression', message: 'Domain policies cannot load runtime implementations.' },
        { selector: 'TSImportType', message: 'Use explicit local domain contracts.' },
        { selector: 'CallExpression[callee.name="require"]', message: 'Domain policies cannot load runtime implementations.' },
      ],
    },
  },
]
