import { readFileSync } from 'node:fs';
import { Script } from 'node:vm';
import ts from 'typescript';
import { expect, it } from 'vitest';
import * as names from '@videoq/domain/course-name';
import * as text from '@videoq/domain/text-value';
import * as slugs from '@videoq/domain/share-slug';
import * as errors from '../src/application/errors';
import { createCourseService } from '../src/features/courses/service';
import { assertCourseNameWorkflow } from './helpers/course-name-workflow-contract';
const path = new URL('../src/features/courses/service.ts',import.meta.url);
const original = readFileSync(path,'utf8');
const imports: Record<string,unknown> = {'@videoq/domain/course-name':names,'@videoq/domain/text-value':text,'@videoq/domain/share-slug':slugs,'../../application/errors':errors};
function loadService(source: string): typeof createCourseService {
  const module = {exports:{}};
  const code = ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
  new Script(code,{filename:'mutated-course-service.cjs'}).runInNewContext({module,exports:module.exports,require:(specifier:string)=>{
    if (!(specifier in imports)) throw new Error(`Unexpected dependency: ${specifier}`);
    return imports[specifier];
  }});
  return (module.exports as {createCourseService:typeof createCourseService}).createCourseService;
}
it('executes the unchanged consumer through the same behavioral contract', async () => {
  await assertCourseNameWorkflow(createCourseService);
  await assertCourseNameWorkflow(loadService(original));
});
it.each([
  ['not called', (s:string)=>s.replaceAll('checkedName(name)','name')],
  ['result ignored', (s:string)=>s.replace('return result.name;','return value;')],
  ['legacy validation copied', (s:string)=>s.replace('const result = normalizeCourseName(value);',"const result = value.length ? {name:value} : {error:'blank'};")],
] as const)('detects real consumer miswiring: %s', async (_name,mutate) => {
  const mutant = mutate(original);
  expect(mutant).not.toBe(original);
  // Imports are unchanged, so reachability alone still accepts every mutant.
  const importsOf=(s:string)=>ts.createSourceFile('source.ts',s,ts.ScriptTarget.Latest,true).statements.filter(ts.isImportDeclaration).map(n=>n.getText());
  expect(importsOf(mutant)).toEqual(importsOf(original));
  const factory=loadService(mutant);
  expect(factory).toBeTypeOf('function');
  await expect(assertCourseNameWorkflow(factory)).rejects.toMatchObject({name:'AssertionError'});
});
