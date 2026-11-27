import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { dirname, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { expect, it } from 'vitest';
const root = fileURLToPath(new URL('../../../', import.meta.url));
type Rule = { path: string; symbols: string[]; consumers: string[] };
const catalog = JSON.parse(readFileSync(resolve(root, 'docs/architecture/domain-rule-ownership.json'), 'utf8')) as { rules: { issue: number; rules: Rule[]; contracts: string[]; supersededBy?: number }[] };
const sources = new Map<string, ts.SourceFile>();
function scan(dir: string) {
  for (const entry of readdirSync(resolve(root, dir), { withFileTypes: true })) {
    const path = `${dir}/${entry.name}`;
    if (entry.isDirectory()) scan(path);
    else if (entry.name.endsWith('.ts')) sources.set(path, ts.createSourceFile(path, readFileSync(resolve(root, path), 'utf8'), ts.ScriptTarget.Latest, true));
  }
}
scan('apps/api/src'); scan('packages/domain/src'); scan('packages/trpc/src');
function definitions(source: ts.SourceFile): string[] {
  return source.statements.flatMap(node => {
    if ((ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node)) && node.name) return [node.name.text];
    if (ts.isVariableStatement(node)) return node.declarationList.declarations.filter(d => ts.isIdentifier(d.name)).map(d => d.name.getText(source));
    return [];
  });
}
function target(from: string, specifier: string): string | undefined {
  if (specifier.startsWith('.')) return relative(root, resolve(root, dirname(from), specifier + '.ts'));
  for (const pkg of ['domain', 'trpc']) {
    const prefix = `@videoq/${pkg}/`;
    if (!specifier.startsWith(prefix)) continue;
    const manifest = JSON.parse(readFileSync(resolve(root, `packages/${pkg}/package.json`), 'utf8')) as { exports: Record<string, string | { default: string }> };
    const entry = manifest.exports['./' + specifier.slice(prefix.length)];
    return entry ? `packages/${pkg}/` + (typeof entry === 'string' ? entry : entry.default).replace(/^\.\//, '') : undefined;
  }
}
function reaches(from: string, owner: string, seen = new Set<string>()): boolean {
  if (from === owner) return true;
  if (seen.has(from)) return false;
  seen.add(from);
  const source = sources.get(from);
  if (!source) return false;
  return source.statements.some(node => {
    if (!(ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) || !node.moduleSpecifier || !ts.isStringLiteral(node.moduleSpecifier)) return false;
    if ((ts.isExportDeclaration(node) && node.isTypeOnly) || (ts.isImportDeclaration(node) && node.importClause?.isTypeOnly)) return false;
    const dependency = target(from, node.moduleSpecifier.text);
    return dependency ? reaches(dependency, owner, seen) : false;
  });
}
it('tracks canonical declarations, import reachability and contract file existence (not runtime calls)', () => {
  expect(catalog.rules.map(x => x.issue)).toEqual(Array.from({ length: 27 }, (_, i) => 1703 + i));
  for (const entry of catalog.rules) {
    expect(entry.contracts.length, `#${entry.issue}`).toBeGreaterThan(0);
    if (entry.supersededBy !== undefined) {
      expect([1712, 1713]).toContain(entry.issue);
      expect(entry.supersededBy).toBe(1701);
      expect(entry.rules).toEqual([]);
      for (const path of ['apps/api/src/domain/skills', 'apps/api/src/features/skills', 'apps/api/src/integrations/agent-skills.ts', 'packages/trpc/src/routers/skills.ts']) {
        expect(existsSync(resolve(root, path)), `removed skill runtime: ${path}`).toBe(false);
      }
    } else if (entry.issue === 1727) {
      expect(entry.contracts).toContain('apps/api/test/domain-rule-ownership.test.ts');
    } else expect(entry.rules.length, `#${entry.issue}`).toBeGreaterThan(0);
    for (const path of entry.contracts) expect(existsSync(resolve(root, path)), path).toBe(true);
    for (const rule of entry.rules) {
      expect(existsSync(resolve(root, rule.path)), rule.path).toBe(true);
      if (!rule.path.endsWith('.ts')) continue;
      for (const name of rule.symbols) {
        const owners = [...sources].filter(([, source]) => definitions(source).includes(name)).map(([path]) => path);
        expect(owners, name).toEqual([rule.path]);
      }
      for (const consumer of rule.consumers) expect(reaches(consumer, rule.path), `${consumer} must reach ${rule.path}`).toBe(true);
    }
  }
});
it('keeps effectful search and delivery execution outside the canonical domain planners', () => {
  for (const path of ['operations/reindex-job.ts', 'search/search-scene-splitting.ts', 'search/streaming-otsu.ts']) {
    const source = sources.get('apps/api/src/domain/' + path)!;
    function visit(node: ts.Node) {
      if (ts.isAwaitExpression(node)) throw new Error(`${path}: external effect in domain planner`);
      if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) expect(['persist', 'dispatch', 'checkpoint', 'embed', 'readBatch']).not.toContain(node.expression.name.text);
      ts.forEachChild(node, visit);
    }
    visit(source);
  }
});
