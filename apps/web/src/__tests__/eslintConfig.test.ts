// @vitest-environment node
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from 'fs'
import { resolve, dirname, join } from 'path'
import { fileURLToPath } from 'url'
import { afterAll, beforeAll, describe, it, expect } from 'vitest'
import { ESLint } from 'eslint'

const __dirname = dirname(fileURLToPath(import.meta.url))
const cases = [
  ['src/pages/ExamplePage.tsx', '@/components/layout/AppPageShell', 'AppPageShell'],
  ['src/pages/ExamplePage.tsx', '../components/layout/AuthLayout', 'AuthLayout'],
  ['src/pages/ExamplePage.tsx', '@/components/layout/AppFooter.tsx', 'AppFooter'],
  ['src/components/video/ExampleView.tsx', '@/components/layout/AppNav', 'AppNav'],
]

describe('eslint.config.js', () => {
  const configContent = readFileSync(resolve(__dirname, '../../eslint.config.js'), 'utf-8')
  const fixtures: string[] = []
  let results: Map<string, ESLint.LintResult>

  beforeAll(async () => {
    const cwd = resolve(__dirname, '../..')
    // CI uses a cached TypeScript program. Write every case before creating it;
    // lintText over placeholder files can otherwise receive a stale source AST.
    for (const [filePath, source, name] of cases) {
      const directory = mkdtempSync(resolve(cwd, dirname(filePath), 'eslint-config-'))
      const fixture = join(directory, 'Example.tsx')
      fixtures.push(fixture)
      writeFileSync(fixture, `import { ${name} } from '${source}'; export default function Example() { return <${name} />; }`)
    }
    const eslint = new ESLint({ cwd })
    results = new Map((await eslint.lintFiles(fixtures)).map(result => [result.filePath, result]))
  }, 60_000)

  afterAll(() => {
    for (const fixture of fixtures) rmSync(dirname(fixture), { recursive: true, force: true })
  })

  it('ignores coverage directory', () => {
    expect(configContent).toMatch(/globalIgnores\(\[.*'coverage'.*\]\)/s)
  })

  it.each(cases.map((entry, index) => [index, ...entry] as const))(
    'rejects page-owned layout imports in case %i (%s from %s)', (index) => {
      expect(results.get(fixtures[index])?.messages).toEqual(expect.arrayContaining([
        expect.objectContaining({ ruleId: 'no-restricted-imports', severity: 2 }),
      ]))
    },
  )
})
