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
  const floating = 'declare function send(): Promise<void>; send(); export {};'
  const misused = 'declare function register(callback: () => void): void; register(async () => { await Promise.resolve(); }); export {};'
  const probes = [
    { name: 'unused.ts', code: 'const unused: string = "unused"; export {};', rule: '@typescript-eslint/no-unused-vars' },
    { name: 'floating.ts', code: floating, rule: '@typescript-eslint/no-floating-promises' },
    { name: 'misused.ts', code: misused, rule: '@typescript-eslint/no-misused-promises' },
    { name: 'value.ts', code: 'export const value: string = "valid";' },
    { name: 'awaited.ts', code: 'declare function send(): Promise<void>; export async function run() { await send(); }' },
    { name: 'caught.ts', code: 'declare function send(): Promise<void>; send().catch(() => undefined); export {};' },
    { name: 'script.mjs', code: 'missingGlobal();', rule: 'no-undef' },
  ]
  for (const suffix of ['test.ts', 'stories.tsx']) {
    probes.push({ name: `floating.${suffix}`, code: floating, rule: '@typescript-eslint/no-floating-promises' })
    probes.push({ name: `misused.${suffix}`, code: misused, rule: '@typescript-eslint/no-misused-promises' })
  }
  if (['apps/web', 'apps/docs', 'apps/demo-video'].includes(project)) {
    probes.push({ name: 'hooks.tsx', code: 'import { useState } from "react"; export function broken() { useState(0); }', rule: 'react-hooks/rules-of-hooks' })
  }
  const fixture = mkdtempSync(join(cwd, 'src', 'eslint-probe-'))
  try {
    // Materialize every case before TypeScript caches the project's files in CI.
    for (const probe of probes) writeFileSync(join(fixture, probe.name), probe.code)
    const eslint = new ESLint({ cwd })
    const results = new Map((await eslint.lintFiles(probes.map(probe => join(fixture, probe.name))))
      .map(result => [result.filePath, result]))
    for (const probe of probes) {
      const result = results.get(join(fixture, probe.name))
      assert.ok(result, `${project}: missing result for ${probe.name}`)
      const diagnostic = `${project}/${probe.name}: ${JSON.stringify(result.messages)}`
      if (probe.rule) assert.ok(result.messages.some(message => message.ruleId === probe.rule), diagnostic)
      else assert.equal(result.errorCount, 0, diagnostic)
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
