import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

async function verify(project) {
  const { ESLint } = await import('eslint')
  const cwd = resolve(project)
  const require = createRequire(resolve(cwd, 'package.json'))
  const compiler = resolve(dirname(require.resolve('@typescript/native/package.json')), 'bin/tsc')
  assert.equal(execFileSync(process.execPath, [compiler, '--version'], { encoding: 'utf8' }).trim(), `Version ${require('@typescript/native/package.json').version}`)
  assert.equal(typeof require('typescript').createProgram, 'function')
  // A real, included file is required for typed linting. Remove it even on failure.
  const fixture = mkdtempSync(join(cwd, 'src', 'eslint-probe-'))
  try {
    const filePath = join(fixture, 'values.ts')
    const hooksPath = join(fixture, 'hooks.tsx')
    writeFileSync(filePath, 'export {};')
    writeFileSync(hooksPath, 'export {};')
    const testPath = join(fixture, 'values.test.ts')
    const storyPath = join(fixture, 'example.stories.tsx')
    writeFileSync(testPath, 'export {};')
    writeFileSync(storyPath, 'export {};')
    const eslint = new ESLint({ cwd })
    const lint = async source => (await eslint.lintText(source, { filePath }))[0]
    const unused = await lint('const unused: string = "unused"; export {};')
    assert.ok(unused.messages.some(message => message.ruleId === '@typescript-eslint/no-unused-vars'), JSON.stringify(unused.messages))
    const floating = await lint('declare function send(): Promise<void>; send();')
    assert.ok(floating.messages.some(message => message.ruleId === '@typescript-eslint/no-floating-promises'), JSON.stringify(floating.messages))
    for (const path of [testPath, storyPath]) {
      const [result] = await eslint.lintText('declare function send(): Promise<void>; send(); export {};', { filePath: path })
      assert.ok(result.messages.some(message => message.ruleId === '@typescript-eslint/no-floating-promises'), JSON.stringify(result.messages))
      const [misusedCallback] = await eslint.lintText('declare function register(callback: () => void): void; register(async () => { await Promise.resolve(); }); export {};', { filePath: path })
      assert.ok(misusedCallback.messages.some(message => message.ruleId === '@typescript-eslint/no-misused-promises'), JSON.stringify(misusedCallback.messages))
    }
    const misused = await lint('declare function register(callback: () => void): void; register(async () => { await Promise.resolve(); });')
    assert.ok(misused.messages.some(message => message.ruleId === '@typescript-eslint/no-misused-promises'), JSON.stringify(misused.messages))
    for (const source of [
      'export const value: string = "valid";',
      'declare function send(): Promise<void>; export async function run() { await send(); }',
      'declare function send(): Promise<void>; send().catch(() => undefined);',
    ]) {
      const valid = await lint(source)
      assert.equal(valid.errorCount, 0, JSON.stringify(valid.messages))
    }
    const [script] = await eslint.lintText('missingGlobal();', { filePath: resolve(cwd, 'scripts/lint-probe.mjs') })
    assert.ok(script.messages.some(message => message.ruleId === 'no-undef'))
    if (['apps/web', 'apps/docs', 'apps/demo-video'].includes(project)) {
      const [hooks] = await eslint.lintText('import { useState } from "react"; export function broken() { useState(0); }', { filePath: hooksPath })
      assert.ok(hooks.messages.some(message => message.ruleId === 'react-hooks/rules-of-hooks'))
    }
  } finally {
    rmSync(fixture, { recursive: true, force: true })
  }
}

if (process.argv[2] === '--workspace') {
  await verify(process.argv[3])
} else {
  for (const project of ['apps/api', 'apps/web', 'apps/docs', 'apps/demo-video', 'packages/trpc']) {
    test(`${project}: native compiler and typed ESLint work side by side`, () => {
      // Release each TypeScript program before checking the next workspace.
      execFileSync(process.execPath, [fileURLToPath(import.meta.url), '--workspace', project], { stdio: 'inherit' })
    })
  }
}
