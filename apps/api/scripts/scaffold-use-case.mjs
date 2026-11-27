import { mkdir, readFile, writeFile, lstat, rename, rm, realpath } from 'node:fs/promises';
import { dirname, resolve, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const types = new Set(['string', 'number', 'boolean', 'string[]', 'number[]', 'boolean[]']);
const identifier = /^[A-Za-z][A-Za-z0-9_]*$/;
const forbidden = new Set(['__proto__', 'prototype', 'constructor', 'default', 'class', 'function', 'import', 'export', 'new', 'var', 'let', 'const', 'return', 'delete', 'await', 'yield', 'extends', 'implements', 'interface', 'public', 'private', 'static', 'enum', 'package', 'switch', 'case', 'null', 'true', 'false']);
const camel = value => value.replace(/-([a-z])/g, (_match, letter) => letter.toUpperCase());
function fields(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Fields must be an object');
  for (const [name, type] of Object.entries(input)) {
    if (!identifier.test(name) || forbidden.has(name) || !types.has(type)) throw new Error('Invalid field name or type');
  }
  return input;
}
function valueMatches(value, type) {
  return type.endsWith('[]') ? Array.isArray(value) && value.every(item => valueMatches(item, type.slice(0, -2)))
    : typeof value === type && (type !== 'number' || Number.isFinite(value));
}
async function exists(path) { try { await lstat(path); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; } }
async function assertSafeAncestors(root, path) {
  let directory = dirname(path);
  while (directory !== root) {
    if (!relative(root, directory) || relative(root, directory).startsWith('..')) throw new Error('Destination escaped the API root');
    if (await exists(directory) && (await lstat(directory)).isSymbolicLink()) throw new Error('Symlink destinations are not supported');
    directory = dirname(directory);
  }
}

export async function scaffoldUseCase({ root, spec }) {
  root = await realpath(root);
  if (!/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(spec.context) || !/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(spec.name)) throw new Error('Use kebab-case context and name');
  if (!spec.description || typeof spec.description !== 'string') throw new Error('Describe the business purpose');
  const input = fields(spec.input), output = fields(spec.output);
  if (!spec.sample || typeof spec.sample !== 'object' || Object.keys(spec.sample).length !== Object.keys(output).length
    || Object.entries(output).some(([key, type]) => !Object.hasOwn(spec.sample, key) || !valueMatches(spec.sample[key], type))) throw new Error('Sample must match every output field');
  const name = `${spec.context}.${camel(spec.name)}`;
  const symbol = `${camel(spec.context)}_${camel(spec.name)}`;
  const feature = `src/features/${spec.context}/use-cases/${spec.name}`;
  const adapter = `src/integrations/generated/${spec.context}/${spec.name}.ts`;
  const fixture = `prototype/use-cases/${spec.context}-${spec.name}.json`;
  const schema = record => `z.object({ ${Object.entries(record).map(([key, type]) => `${key}: z.${type.replace('[]', '')}()${type.endsWith('[]') ? '.array()' : ''}`).join(', ')} }).strict()`;
  const declaration = record => Object.entries(record).map(([key, type]) => `  ${key}: ${type};`).join('\n');
  const files = new Map([
    [`${feature}/contracts.ts`, `import type { UseCase } from '../../../../application/use-case-bus';\n\nexport type Input = {\n${declaration(input)}\n};\nexport type Output = {\n${declaration(output)}\n};\nexport type InputPort = UseCase<Input, Output>;\n`],
    [`${feature}/service.ts`, `import type { InputPort } from './contracts';\n\n/** Compose domain rules here; inject external capabilities through Dependencies. */\nexport type Dependencies = { perform: InputPort };\nexport function createInteractor(dependencies: Dependencies): InputPort {\n  return input => dependencies.perform(input);\n}\n`],
    [adapter, `import { z } from 'zod';\nimport { createUseCaseBus } from '../../../application/use-case-bus';\nimport { createScenarioRunner, type ScenarioSnapshot } from '../../../application/scenario';\nimport { createInteractor, type Dependencies } from '../../../features/${spec.context}/use-cases/${spec.name}/service';\nimport type { Input } from '../../../features/${spec.context}/use-cases/${spec.name}/contracts';\nimport type { Output } from '../../../features/${spec.context}/use-cases/${spec.name}/contracts';\n\ntype Outputs = { '${name}': Output };\nexport const definition = {\n  name: '${name}',\n  input: ${schema(input)} satisfies z.ZodType<Input>,\n  output: ${schema(output)} satisfies z.ZodType<Output>,\n  create(options: { mode: 'production'; dependencies: Dependencies } | { mode: 'stub'; load: () => Promise<ScenarioSnapshot<Outputs>> }) {\n    const runner = options.mode === 'stub' ? createScenarioRunner(options.load, structuredClone) : undefined;\n    const service = options.mode === 'production' ? createInteractor(options.dependencies)\n      : ((_input: Input) => runner!.execute('${name}'));\n    return createUseCaseBus({ '${name}': service });\n  },\n};\n`],
    [fixture, JSON.stringify({ version: 1, repeatLast: true, cases: { [name]: [{ output: spec.sample }] } }, null, 2) + '\n'],
    [`test/generated/${spec.context}-${spec.name}.test.ts`, `import { expect, it } from 'vitest';\nimport { definition } from '../../integrations-placeholder';\n\nit('keeps generated input/output fixtures compatible with the port', async () => {\n  const output = definition.output.parse(${JSON.stringify(spec.sample)});\n  const input = definition.input.parse(${JSON.stringify(Object.fromEntries(Object.entries(input).map(([key, type]) => [key, type.endsWith('[]') ? [] : type === 'string' ? 'example' : type === 'number' ? 1 : true])))});\n  const bus = definition.create({ mode: 'production', dependencies: { perform: async () => output } });\n  expect(await bus.execute('${name}', input)).toEqual(output);\n});\n`.replace('../../integrations-placeholder', `../../src/integrations/generated/${spec.context}/${spec.name}`)],
  ]);
  const registryPath = resolve(root, 'src/integrations/generated/registry.ts');
  const lockPath = resolve(root, '.scaffold-use-case.lock');
  // An exclusive lock prevents two generators losing each other's registrations.
  await writeFile(lockPath, '', { flag: 'wx' });
  const created = [];
  try {
    for (const path of [...files.keys(), 'src/integrations/generated/registry.ts']) await assertSafeAncestors(root, resolve(root, path));
    for (const path of files.keys()) if (await exists(resolve(root, path))) throw new Error(`Refusing to overwrite ${path}`);
    if (await exists(registryPath) && (await lstat(registryPath)).isSymbolicLink()) throw new Error('Symlink registry is not supported');
    let registry = await exists(registryPath) ? await readFile(registryPath, 'utf8') : 'export const generatedUseCases = {\n};\n';
    if (!registry.includes('export const generatedUseCases = {\n') || !registry.endsWith('};\n')) throw new Error('Unrecognized generated registry');
    if (registry.includes(`'${name}'`)) throw new Error('Use case is already registered');
    registry = `import { definition as ${symbol} } from './${spec.context}/${spec.name}';\n` + registry.replace('export const generatedUseCases = {\n', `export const generatedUseCases = {\n  '${name}': ${symbol},\n`);
    for (const [path, text] of files) {
      const destination = resolve(root, path);
      await mkdir(dirname(destination), { recursive: true });
      await writeFile(destination, text, { flag: 'wx' });
      created.push(destination);
    }
    await mkdir(dirname(registryPath), { recursive: true });
    const staged = registryPath + '.tmp';
    await writeFile(staged, registry, { flag: 'wx' });
    await rename(staged, registryPath);
    return { name, files: [...files.keys(), 'src/integrations/generated/registry.ts'] };
  } catch (error) {
    await Promise.all(created.map(path => rm(path)));
    throw error;
  } finally { await rm(lockPath); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [specPath, ...extra] = process.argv.slice(2);
  if (!specPath || extra.length) throw new Error('Usage: npm run use-case:new -- <spec.json>');
  const root = fileURLToPath(new URL('../', import.meta.url));
  console.log(JSON.stringify(await scaffoldUseCase({ root, spec: JSON.parse(await readFile(resolve(specPath), 'utf8')) }), null, 2));
}
