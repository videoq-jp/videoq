import { readFileSync, readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { cwd } from 'node:process';
import ts from 'typescript';
import { expect, it } from 'vitest';

it('keeps all frontend application modules independent of UI and transport implementations', () => {
  const root = resolve(cwd(), 'src/application') + '/';
  function inspect(directory: string): void {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = resolve(directory, entry.name);
      if (entry.isDirectory()) { inspect(path); continue; }
      if (!path.endsWith('.ts')) continue;
      const tree = ts.createSourceFile(path, readFileSync(path, 'utf8'), ts.ScriptTarget.Latest, true);
      function visit(node: ts.Node): void {
        if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier) {
          expect(ts.isStringLiteral(node.moduleSpecifier), path).toBe(true);
          const dependency = (node.moduleSpecifier as ts.StringLiteral).text;
          if (dependency.startsWith('.')) {
            expect(resolve(dirname(path), dependency).startsWith(root), `${path}: ${dependency}`).toBe(true);
          } else {
            expect(dependency.startsWith('@videoq/domain/'), `${path}: ${dependency}`).toBe(true);
          }
        }
        expect(ts.isImportTypeNode(node), path).toBe(false);
        expect(ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword, path).toBe(false);
        expect(ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'require', path).toBe(false);
        ts.forEachChild(node, visit);
      }
      visit(tree);
    }
  }
  inspect(root);
});
