import ts from 'typescript';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
const root = fileURLToPath(new URL('../../../', import.meta.url));
const catalog = JSON.parse(readFileSync(resolve(root,'docs/architecture/domain-rule-ownership.json'),'utf8'));
const manifest = JSON.parse(readFileSync(resolve(root,'docs/architecture/ownership-behavioral-controls.json'),'utf8'));
const controls = manifest.controls as Array<{
  id:string; owner:string; consumer:string; symbols:string[]; tests:string[]; modes:string[]; legacyCopy:string;
  failureWitnesses: Record<string, { testFile?: string; test: string; error: string }>;
}>;
it('maps every registered TypeScript consumer/owner pair to executable behavioral contracts', () => {
  const pairs = [...catalog.rules,...catalog.followUps].flatMap(group => group.rules.flatMap(rule =>
    rule.consumers.filter((p:string) => p.endsWith('.ts')).map((consumer:string) => `${rule.path}:${consumer}`)));
  expect(controls.map(row => `${row.owner}:${row.consumer}`).sort()).toEqual(pairs.sort());
  expect(new Set(controls.map(row => row.id)).size).toBe(controls.length);
  for (const row of controls) {
    expect(row.symbols.length,row.id).toBeGreaterThan(0);
    const source=ts.createSourceFile(row.owner,readFileSync(resolve(root,row.owner),'utf8'),ts.ScriptTarget.Latest,true);
    const names=source.statements.flatMap(n => (ts.isFunctionDeclaration(n)||ts.isClassDeclaration(n))&&n.name?[n.name.text]
      :ts.isVariableStatement(n)?n.declarationList.declarations.filter(d=>ts.isIdentifier(d.name)).map(d=>d.name.getText(source)):[]);
    for(const symbol of row.symbols)expect(names,`${row.id}: ${symbol}`).toContain(symbol);
    expect(row.modes,row.id).toEqual(['bypass','ignore-result']);
    expect(row.tests.length,row.id).toBeGreaterThan(0);
    for (const test of row.tests) {
      expect(test,row.id).toMatch(/^test\/.*\.test\.ts$/);
      expect(existsSync(resolve(root,'apps/api',test)),`${row.id}: ${test}`).toBe(true);
    }
    expect(row.legacyCopy.length,row.id).toBeGreaterThan(0);
    expect(Object.keys(row.failureWitnesses).sort(), row.id).toEqual([...row.modes].sort());
    for (const witness of Object.values(row.failureWitnesses)) {
      expect(row.tests, row.id).toContain(witness.testFile);
      expect(witness.test.length, row.id).toBeGreaterThan(0);
      expect(witness.error.length, row.id).toBeGreaterThan(0);
      expect(witness.error, row.id).not.toMatch(/[\n\r]/);
      expect(witness.error.includes(String.fromCharCode(27)), row.id).toBe(false);
    }
  }
});

it('also inventories every registered Python consumer/owner pair', () => {
  const pairs = [...catalog.rules,...catalog.followUps].flatMap(group => group.rules.flatMap(rule =>
    rule.consumers.filter((p:string) => p.endsWith('.py')).map((consumer:string) => `${rule.path}:${consumer}`)));
  const python = manifest.pythonControls as typeof controls;
  expect(python.map(row => `${row.owner}:${row.consumer}`).sort()).toEqual(pairs.sort());
  for (const row of python) {
    expect(row.modes).toEqual(['bypass','ignore-result']);
    expect(row.tests.length).toBeGreaterThan(0);
    for (const test of row.tests) expect(existsSync(resolve(root,'apps/worker',test))).toBe(true);
    expect(Object.keys(row.failureWitnesses).sort(), row.id).toEqual([...row.modes].sort());
    for (const witness of Object.values(row.failureWitnesses)) {
      expect(witness.test, row.id).toContain('::');
      const testFile = witness.test.split('::')[0].replaceAll('.', '/') + '.py';
      expect(row.tests, row.id).toContain(testFile);
      expect(witness.error.length, row.id).toBeGreaterThan(0);
      expect(witness.error, row.id).not.toMatch(/[\n\r]/);
      expect(witness.error.includes(String.fromCharCode(27)), row.id).toBe(false);
    }
  }
});
