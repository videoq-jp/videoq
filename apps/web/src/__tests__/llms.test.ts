// @vitest-environment node
import { readFileSync } from 'fs'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'
import { describe, it, expect, beforeAll } from 'vitest'

const __dirname = dirname(fileURLToPath(import.meta.url))

describe('llms.txt', () => {
  let content: string

  beforeAll(() => {
    content = readFileSync(
      resolve(__dirname, '../../public/llms.txt'),
      'utf-8'
    )
  })

  // ── Structure ────────────────────────────────────────────────────────────────

  it('starts with # VideoQ heading', () => {
    expect(content.trimStart()).toMatch(/^# VideoQ/)
  })

  it('has a blockquote description (> ...)', () => {
    expect(content).toMatch(/^>/m)
  })

  // ── Required sections ────────────────────────────────────────────────────────

  const REQUIRED_SECTIONS = [
    '## Key Features',
    '## Use Cases',
    '## Integrations',
  ]

  it.each(REQUIRED_SECTIONS)('contains section "%s"', (section) => {
    expect(content).toContain(section)
  })

  // ── Use Cases section ────────────────────────────────────────────────────────

  it('Use Cases section mentions education', () => {
    const idx = content.indexOf('## Use Cases')
    const nextSection = content.indexOf('\n## ', idx + 1)
    const section = content.slice(idx, nextSection === -1 ? undefined : nextSection)
    expect(section.toLowerCase()).toMatch(/educat/)
  })

  it('Use Cases section covers the instructor audiences', () => {
    const idx = content.indexOf('## Use Cases')
    const nextSection = content.indexOf('\n## ', idx + 1)
    const section = content.slice(idx, nextSection === -1 ? undefined : nextSection)
    expect(section).toMatch(/Online courses/)
    expect(section).toMatch(/Schools/)
    expect(section).toMatch(/Staff training/)
    expect(content).not.toMatch(/university students|\?audience=student/)
  })

  // ── Integrations section ─────────────────────────────────────────────────────

  it('Integrations section does not advertise the removed OpenAI-compatible endpoint', () => {
    const idx = content.indexOf('## Integrations')
    const nextSection = content.indexOf('\n## ', idx + 1)
    const section = content.slice(idx, nextSection === -1 ? undefined : nextSection)
    expect(section).not.toMatch(/\/api\/v1\/chat\/completions/)
  })

  it('Integrations section mentions MCP', () => {
    const idx = content.indexOf('## Integrations')
    const nextSection = content.indexOf('\n## ', idx + 1)
    const section = content.slice(idx, nextSection === -1 ? undefined : nextSection)
    expect(section).toMatch(/MCP|Model Context Protocol/)
    expect(section).toMatch(/upload|アップロード/)
    expect(section).toMatch(/create courses|講座作成/)
  })

  // ── No mixed Japanese/English on the same bullet line ───────────────────────

  it('does not mix Japanese and ASCII text on the same bullet line with a slash separator', () => {
    const lines = content.split('\n')
    const mixedLines = lines.filter((line) => {
      if (!line.startsWith('- ')) return false
      // Detect lines with Japanese characters AND " / " (slash-separated bilingual)
      const hasJapanese = /[\u3000-\u9fff\uff00-\uffef]/.test(line)
      const hasSlashSeparator = / \/ /.test(line)
      return hasJapanese && hasSlashSeparator
    })
    expect(mixedLines).toHaveLength(0)
  })
})
