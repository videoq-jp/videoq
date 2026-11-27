import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import ts from 'typescript';

// Transform only the selected consumer in Vite's in-memory source. Production
// files, imports, and the canonical owner are never changed by this harness.
export function ownershipMutation() {
  const control = process.env.OWNERSHIP_CONTROL;
  if (!control) return { name: 'ownership-control-disabled' };
  const row = JSON.parse(readFileSync(control, 'utf8'));
  const target = resolve('../../', row.consumer);
  const mode = process.env.OWNERSHIP_MODE ?? 'baseline';
  return { name: 'ownership-behavioral-control', enforce: 'pre', transform(code, id) {
    if (id.split('?')[0] !== target) return;
    const source = ts.createSourceFile(id, code, ts.ScriptTarget.Latest, true);
    const names = new Set(row.symbols);
    for (const statement of source.statements) {
      if (ts.isImportDeclaration(statement) && statement.importClause?.namedBindings && ts.isNamedImports(statement.importClause.namedBindings)) {
        for (const item of statement.importClause.namedBindings.elements) {
          if (names.has(item.propertyName?.text ?? item.name.text)) names.add(item.name.text);
        }
      }
    }
    const edits = [];
    function visit(node) {
      if ((ts.isCallExpression(node) || ts.isNewExpression(node)) && names.has(node.expression.getText(source))) {
        const original = node.getText(source);
        edits.push({ start: node.getStart(source), end: node.end,
          replacement: mode === 'ignore-result' ? `(${original}, void 0)` : '(void 0)' });
        return;
      }
      ts.forEachChild(node, visit);
    }
    visit(source);
    // A re-export-only adapter is evaluated at its exported function boundary.
    // Keep a callable export; deleting an export would merely test module linking.
    for (const statement of source.statements) {
      if (!ts.isExportDeclaration(statement) || !statement.exportClause || !ts.isNamedExports(statement.exportClause) || !statement.moduleSpecifier) continue;
      const exports = statement.exportClause.elements.filter(item => names.has(item.propertyName?.text ?? item.name.text));
      if (!exports.length) continue;
      const remaining = statement.exportClause.elements.filter(item => !exports.includes(item));
      let replacement = remaining.length ? `export { ${remaining.map(n => n.getText(source)).join(', ')} } from ${statement.moduleSpecifier.getText(source)};\n` : '';
      for (const [index, item] of exports.entries()) {
        const imported = item.propertyName?.text ?? item.name.text, alias = `__ownership_${index}_${imported}`;
        replacement += `import { ${imported} as ${alias} } from ${statement.moduleSpecifier.getText(source)};\nexport const ${item.name.text} = (...args: any[]) => ${mode === 'ignore-result' ? `(${alias}(...args), void 0)` : 'void 0'};\n`;
      }
      edits.push({start:statement.getStart(source),end:statement.end,replacement});
    }
    writeFileSync(process.env.OWNERSHIP_TRANSFORM_RECEIPT, JSON.stringify({ consumer:row.consumer, mode, sites:edits.length }));
    if (mode === 'baseline') return;
    for (const edit of edits.sort((a,b) => b.start-a.start)) code = code.slice(0,edit.start)+edit.replacement+code.slice(edit.end);
    return { code, map:null };
  } };
}
