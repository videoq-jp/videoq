// @vitest-environment node
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from 'fs'
import { resolve, dirname, join } from 'path'
import { fileURLToPath } from 'url'
import { afterAll, beforeAll, describe, it, expect } from 'vitest'
import { ESLint } from 'eslint'

const __dirname = dirname(fileURLToPath(import.meta.url))

describe('eslint.config.js', () => {
  const configContent = readFileSync(
    resolve(__dirname, '../../eslint.config.js'),
    'utf-8',
  )
  let eslint: ESLint
  let fixtures: string[] = []

  beforeAll(async () => {
    eslint = new ESLint({ cwd: resolve(__dirname, '../..') })
    fixtures = ['src/pages', 'src/components/video'].map(directory => {
      const fixture = mkdtempSync(resolve(__dirname, '..', directory.replace('src/', ''), 'eslint-config-'))
      const file = join(fixture, 'Example.tsx')
      writeFileSync(file, 'export {};')
      return file
    })
    await eslint.lintText('export {};', { filePath: fixtures[0] })
  }, 60_000)

  afterAll(() => { for (const fixture of fixtures) rmSync(dirname(fixture), { recursive: true, force: true }) })

  it('ignores coverage directory', () => {
    expect(configContent).toMatch(/globalIgnores\(\[.*'coverage'.*\]\)/s)
  })

  it.each([
    ['src/pages/ExamplePage.tsx', '@/components/layout/AppPageShell', 'AppPageShell'],
    ['src/pages/ExamplePage.tsx', '../components/layout/AuthLayout', 'AuthLayout'],
    ['src/pages/ExamplePage.tsx', '@/components/layout/AppFooter.tsx', 'AppFooter'],
    ['src/components/video/ExampleView.tsx', '@/components/layout/AppNav', 'AppNav'],
  ])('rejects page-owned layout imports in %s from %s', async (filePath, source, name) => {
    const [result] = await eslint.lintText(
      `import { ${name} } from '${source}'; export default function Example() { return <${name} />; }`,
      { filePath: filePath.includes('/pages/') ? fixtures[0] : fixtures[1] },
    )
    expect(result.messages).toEqual(expect.arrayContaining([
      expect.objectContaining({ ruleId: 'no-restricted-imports', severity: 2 }),
    ]))
  })
})
