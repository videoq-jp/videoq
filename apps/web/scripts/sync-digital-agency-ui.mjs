import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const registry = 'videoq-jp/shadcn-digital-agency-jp' // last synced: v0.8.6

// Keep this list aligned with imports from src/components/ui. Do not use the
// registry's all-components block: it installs demo-only components and their
// dependencies in addition to the primitives used by VideoQ.
// Generated files are trimmed to the exports used by the app and stories.
// After syncing, review additions for unused components and run the web checks.
const components = [
  'theme',
  'digital-agency-cn',
  'breadcrumbs',
  'button',
  'checkbox',
  'chip-label',
  'dialog',
  'divider',
  'error-text',
  'hamburger-menu-button',
  'heading',
  'input',
  'label',
  'language-selector',
  'link',
  'list',
  'menu-list',
  'notification-banner',
  'progress-indicator',
  'requirement-badge',
  'select',
  'step-navigation',
  'support-text',
  'table',
  'textarea',
  'utility-link',
]

const frontendDirectory = fileURLToPath(new URL('../', import.meta.url))
const requestedArguments = process.argv.slice(2)
const registryItems = components.map((component) => `${registry}/${component}`)

const result = spawnSync(
  'npx',
  [
    '--yes',
    'shadcn@latest',
    'add',
    ...registryItems,
    '--overwrite',
    '--yes',
    ...requestedArguments,
  ],
  {
    cwd: frontendDirectory,
    stdio: 'inherit',
  },
)

if (result.error) {
  throw result.error
}

if (result.signal) {
  console.error(`shadcn was terminated by ${result.signal}`)
  process.exit(1)
}

process.exit(result.status ?? 1)
