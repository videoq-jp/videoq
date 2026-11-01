import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { dirname, resolve } from 'node:path'
import { execFileSync } from 'node:child_process'
import { test } from 'node:test'
import { ESLint } from 'eslint'

const root = process.cwd()
for (const project of ['apps/api', 'apps/web', 'apps/docs', 'apps/demo-video', 'packages/trpc']) {
  test(`${project}: native compiler and ESLint work side by side`, async () => {
    const cwd = resolve(root, project)
    const require = createRequire(resolve(cwd, 'package.json'))
    // Check the compiler executable and the API actually resolved by this workspace.
    const compiler = resolve(dirname(require.resolve('@typescript/native/package.json')), 'bin/tsc')
    assert.equal(execFileSync(process.execPath, [compiler, '--version'], { encoding: 'utf8' }).trim(), `Version ${require('@typescript/native/package.json').version}`)
    assert.equal(typeof require('typescript').createProgram, 'function')
    const eslint = new ESLint({ cwd })
    const [invalid] = await eslint.lintText('const unused: string = "unused"; export {};', { filePath: 'src/lint-probe.ts' })
    assert.ok(invalid.messages.some(message => message.ruleId === '@typescript-eslint/no-unused-vars'))
    const [valid] = await eslint.lintText('export const value: string = "valid";', { filePath: 'src/lint-probe.ts' })
    assert.equal(valid.errorCount, 0, JSON.stringify(valid.messages))
    const [script] = await eslint.lintText('missingGlobal();', { filePath: 'scripts/lint-probe.mjs' })
    assert.ok(script.messages.some(message => message.ruleId === 'no-undef'))
    if (['apps/web', 'apps/docs', 'apps/demo-video'].includes(project)) {
      const [hooks] = await eslint.lintText('import { useState } from "react"; export function broken() { useState(0); }', { filePath: 'src/lint-probe.tsx' })
      assert.ok(hooks.messages.some(message => message.ruleId === 'react-hooks/rules-of-hooks'))
    }
  })
}
