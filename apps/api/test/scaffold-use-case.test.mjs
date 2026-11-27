import { afterEach, expect, it } from 'vitest';
import { mkdtemp, mkdir, readFile, writeFile, copyFile, symlink, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { scaffoldUseCase } from '../scripts/scaffold-use-case.mjs';

const exec = promisify(execFile);
const api = fileURLToPath(new URL('../', import.meta.url));
const temporary = [];
afterEach(async () => { await Promise.all(temporary.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
const spec = { context: 'learning', name: 'course-outline', description: 'Preview a course outline',
  input: { courseId: 'number' }, output: { title: 'string', sections: 'string[]' }, sample: { title: 'Example', sections: ['Introduction'] } };
async function root() {
  const path = await mkdtemp(join(tmpdir(), 'videoq-scaffold-')); temporary.push(path);
  await mkdir(join(path, 'src/application'), { recursive: true });
  for (const name of ['use-case-bus.ts', 'scenario.ts', 'errors.ts']) await copyFile(join(api, 'src/application', name), join(path, 'src/application', name));
  await symlink(resolve(api, '../../node_modules'), join(path, 'node_modules'));
  await writeFile(join(path, 'package.json'), '{"type":"module"}');
  return path;
}
it('generates registered production/stub ports, compiles their types, and executes the generated regression', async () => {
  const path = await root();
  const result = await scaffoldUseCase({ root: path, spec });
  expect(result.name).toBe('learning.courseOutline');
  await scaffoldUseCase({ root: path, spec: { ...spec, name: 'another-outline' } });
  const registry = await readFile(join(path, 'src/integrations/generated/registry.ts'), 'utf8');
  expect(registry).toContain("'learning.courseOutline'"); expect(registry).toContain("'learning.anotherOutline'");
  await writeFile(join(path, 'verify.ts'), `import { generatedUseCases } from './src/integrations/generated/registry';
const definition = generatedUseCases['learning.courseOutline'];
const expected = definition.output.parse(${JSON.stringify(spec.sample)});
const input = definition.input.parse({ courseId: 1 });
const production = definition.create({ mode: 'production', dependencies: { perform: async () => expected } });
const stub = definition.create({ mode: 'stub', load: async () => ({ revision: '1', repeatLast: false,
  cases: { 'learning.courseOutline': [{ output: expected }, { output: { title: 'Second', sections: [] } }] } }) });
if ((await production.execute('learning.courseOutline', input)).title !== 'Example') throw new Error('Production registration failed');
if ((await stub.execute('learning.courseOutline', input)).title !== 'Example') throw new Error('First fixture failed');
if ((await stub.execute('learning.courseOutline', input)).title !== 'Second') throw new Error('Sequential fixture failed');
if (false) {
// @ts-expect-error The bus preserves the generated input type.
void stub.execute('learning.courseOutline', { courseId: 'wrong' });
// @ts-expect-error The output type cannot be changed at the call site.
const bad: Promise<number> = stub.execute('learning.courseOutline', input);
void bad;
}
console.log('generated ports verified');
`);
  await writeFile(join(path, 'tsconfig.json'), JSON.stringify({ compilerOptions: { target: 'ESNext', module: 'ESNext', moduleResolution: 'Bundler', strict: true, skipLibCheck: true, types: ['node'], lib: ['ESNext'], noEmit: true }, include: ['src/**/*.ts', 'verify.ts'] }));
  await exec(process.execPath, [resolve(api, '../../node_modules/.bin/tsc'), '-p', join(path, 'tsconfig.json')], { timeout: 30000 });
  const execution = await exec(process.execPath, [join(api, 'node_modules/tsx/dist/cli.mjs'), join(path, 'verify.ts')], { timeout: 15000 });
  expect(execution.stdout).toContain('generated ports verified');
  await mkdir(join(path, 'scripts'), { recursive: true });
  await copyFile(join(api, 'scripts/run-use-case.mjs'), join(path, 'scripts/run-use-case.mjs'));
  const command = await exec(process.execPath, [join(api, 'node_modules/tsx/dist/cli.mjs'), join(path, 'scripts/run-use-case.mjs'),
    'learning.courseOutline', '{"courseId":1}', join(path, 'prototype/use-cases/learning-course-outline.json'), '2'], { cwd: path, timeout: 15000 });
  expect(command.stdout.trim().split('\n').map(line => JSON.parse(line))).toEqual([spec.sample, spec.sample]);

  await writeFile(join(path, 'vitest.config.mjs'), 'export default {test:{maxWorkers:1}};');
  const regression = await exec(process.execPath, [resolve(api, '../../node_modules/vitest/vitest.mjs'), 'run', '--root', path, '--config', join(path, 'vitest.config.mjs')], { cwd: path, timeout: 30000 });
  expect(regression.stdout).toContain('2 passed');
});
it('refuses overwrites and invalid names/types without changing existing files', async () => {
  const path = await root();
  await scaffoldUseCase({ root: path, spec });
  const registryPath = join(path, 'src/integrations/generated/registry.ts');
  const original = await readFile(registryPath, 'utf8');
  await expect(scaffoldUseCase({ root: path, spec })).rejects.toThrow('Refusing to overwrite');
  for (const broken of [{ ...spec, name: '../escape' }, { ...spec, input: { x: 'string; process.exit()' } }, { ...spec, output: { title: 'number' } }]) {
    await expect(scaffoldUseCase({ root: path, spec: broken })).rejects.toThrow();
  }
  expect(await readFile(registryPath, 'utf8')).toBe(original);
});
it('serializes registry changes and rejects symlink destinations', async () => {
  const path = await root(), elsewhere = await root();
  await mkdir(join(path, 'src/features'), { recursive: true });
  await symlink(elsewhere, join(path, 'src/features/learning'));
  await expect(scaffoldUseCase({ root: path, spec })).rejects.toThrow('Symlink');
  expect(await readdir(elsewhere)).not.toContain('use-cases');
  await rm(join(path, 'src/features/learning'));
  await writeFile(join(path, '.scaffold-use-case.lock'), 'busy');
  await expect(scaffoldUseCase({ root: path, spec })).rejects.toMatchObject({ code: 'EEXIST' });
  await rm(join(path, '.scaffold-use-case.lock'));
  await mkdir(join(path, 'src/integrations/generated'), { recursive: true });
  const target = join(elsewhere, 'registry.ts');
  await writeFile(target, 'untouched');
  await symlink(target, join(path, 'src/integrations/generated/registry.ts'));
  await expect(scaffoldUseCase({ root: path, spec })).rejects.toThrow('Symlink registry');
  expect(await readFile(target, 'utf8')).toBe('untouched');

});
