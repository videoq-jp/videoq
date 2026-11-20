import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { ESLint } from "eslint";
import tseslint from "typescript-eslint";
import { readFileSync, readdirSync } from "node:fs";
import ts from "typescript";

it("prevents extracted use cases from acquiring runtime and implementation dependencies", async () => {
  const cwd = fileURLToPath(new URL("../", import.meta.url));
  const eslint = new ESLint({
    cwd,
    // Import restrictions are syntax rules. Avoid rebuilding typed projects for
    // synthetic sources; the repository lint command still checks all type rules.
    overrideConfig: [tseslint.configs.disableTypeChecked],
  });
  const protectedPaths: string[] = [];
  async function collect(directory: string): Promise<void> {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = resolve(directory, entry.name);
      if (entry.isDirectory()) { await collect(path); continue; }
      if (!path.endsWith('.ts')) continue;
      const rules = (await eslint.calculateConfigForFile(path))?.rules;
      const restriction = JSON.stringify(rules?.['no-restricted-imports']);
      if (restriction?.includes('Application workflows and their contracts') || restriction?.includes('Application models and persistence ports')) {
        protectedPaths.push(path.slice(cwd.length));
      }
    }
  }
  await collect(resolve(cwd, 'src'));
  expect(protectedPaths.length).toBeGreaterThan(0);
  for (const relativePath of protectedPaths) {
    const filePath = resolve(cwd, relativePath);
    for (const source of [
      'export { videoUploadService } from "../../integrations/video-upload";',
      'export type { Bindings } from "../../types/bindings";',
      'export { createQaRepository } from "../../persistence/factory";',
      'export { createD1QaRepository } from "../../persistence/d1/qa-repository";',
      'export { quotaSqlComparison } from "../../persistence/quota-policy-sql";',
      'export { resourceSqlErrorChoice } from "../../persistence/resource-policy-sql";',
      'export { lmsOwnerStringLogic } from "../../persistence/lms-owner-policy";',
      'export { membershipSqlLogic } from "../../persistence/membership-policy-sql";',
      'export { privacyStringLogic } from "../../persistence/privacy-policy-sql";',
      'export { pairingSqlLogic } from "../../persistence/pairing-policy-sql";',
      'export { transcriptionStringLogic } from "../../persistence/transcription-policy-sql";',
      'export { visualStringLogic } from "../../persistence/visual-policy-sql";',
      'export { accountDeletionStringLogic } from "../../persistence/worker-account-deletion-policy-sql";',
      'export { conversationStringLogic } from "../../persistence/conversation-policy-sql";',
      'export { videoReadDrizzleLogic } from "../../persistence/video-read-policy-sql";',
      'export { videoReadDrizzleLogic } from "../../persistence/video-read-policy-sql";',
      'export { videoMutationStringLogic } from "../../persistence/video-mutation-policy-sql";',
      'export { reportStringLogic } from "../../persistence/course-report-policy-sql";',
      'export { historyDrizzleChoice } from "../../persistence/course-history-policy-sql";',
      'export { contentDrizzleLogic } from "../../persistence/content-read-policy-sql";',
      'export { sceneVisibilityDrizzleLogic } from "../../persistence/scene-retrieval-policy-sql";',
      'export { sceneIndexStringLogic } from "../../persistence/scene-index-policy-sql";',
      'export { mediaStringLogic } from "../../persistence/media-eligibility-sql";',
      'export { subscriptionDrizzleChoice } from "../../persistence/admin-policy-sql";',
      'export { invitationStringChoice } from "../../persistence/invitation-policy-sql";',
      'export { courseD1OrderPlanning } from "../../persistence/course-management-policy-sql";',
      'export { nativeCourseStringLogic } from "../../persistence/native-course-policy-sql";',
      'export { storageCleanupStringLogic } from "../../persistence/external-task-policy-sql";',
      'export { billingDrizzleBanLogic } from "../../persistence/billing-policy-sql";',
      'export { ApiError } from "../../shared/errors";',
      'export { sampleByTime } from "../../lib/video-evidence";',
      'export const load = () => import("../../integrations/video-upload");',
      'export type { Price } from "stripe";',
      'export type { Context } from "hono";',
      'export type { BaseCheckpointSaver } from "@langchain/langgraph-checkpoint";',
      'export type Runtime = import("../../types/bindings").Bindings;',
      'const runtime = require("../../types/bindings");',

    ]) {
      const [result] = await eslint.lintText(source, { filePath });
      expect(result.messages.some(message => message.ruleId === "no-restricted-imports" || message.ruleId === "no-restricted-syntax"), `${source}: ${JSON.stringify(result.messages)}`).toBe(true);
    }
    const allowedSource = relativePath.startsWith('src/application/')
      ? 'export type { ChatAnswer } from "./models";'
      : relativePath.startsWith('src/persistence/contracts/')
        ? 'export type { VideoUploadRepository } from "./video-upload-repository";'
        : 'export type { VideoUploadRepository } from "../../persistence/contracts/video-upload-repository";';
    const [allowed] = await eslint.lintText(allowedSource, { filePath });
    expect(allowed.errorCount, JSON.stringify(allowed.messages)).toBe(0);
  }
// This checks every protected module against every forbidden source. Typed
// workspace lint remains separate; allow CPU contention in the full DB suite.
}, 90_000);

it('keeps Q&A application contracts independent of the RPC schema', async () => {
  const cwd = fileURLToPath(new URL('../', import.meta.url));
  const eslint = new ESLint({ cwd, overrideConfig: [tseslint.configs.disableTypeChecked] });
  for (const relativePath of ['src/features/qa/core.ts', 'src/features/qa/service.ts', 'src/persistence/contracts/qa-repository.ts']) {
    for (const source of [
      'export type { RpcInputMap } from "@videoq/trpc";',
      'export const load = () => import("@videoq/trpc");',
      'export type Inputs = import("@videoq/trpc").RpcInputMap;',
    ]) {
      const [result] = await eslint.lintText(source, { filePath: resolve(cwd, relativePath) });
      expect(result.messages.some(message => message.ruleId === 'no-restricted-imports' || message.ruleId === 'no-restricted-syntax')).toBe(true);
    }
  }
});


it('checks real transitive dependencies of the extracted workflows, including type-only imports', async () => {
  const cwd = fileURLToPath(new URL('../', import.meta.url));
  const eslint = new ESLint({ cwd, overrideConfig: [tseslint.configs.disableTypeChecked] });
  const config = JSON.parse(readFileSync(resolve(cwd, 'tsconfig.application.json'), 'utf8')) as { include: string[] };
  const roots = config.include.filter(path => !path.includes('*')).map(path => path.replace(/^src\//, '').replace(/\.ts$/, ''));
  const pureFiles = new Set([
    ...roots, 'features/billing/catalog', 'features/billing/ports',
    'features/lms/materials-sync-ports', 'features/maintenance/ports', 'features/tasks/ports', 'features/course-memberships/ports', 'features/chat/generation-ports', 'features/videos/management-ports',
    ...['invitation-create-repository', 'invitation-read-repository', 'invitation-write-repository', 'invitation-delivery-repository', 'external-task-repository', 'lti-registration-repository', 'linked-learning-repository', 'credential-repository', 'media-repository', 'tag-repository', 'ai-quota', 'membership-repository', 'qa-repository', 'billing-repository', 'course-repository', 'conversation-read', 'chat-repository',
      'lti-subject', 'creation-idempotency', 'video-read-repository', 'video-upload-repository',
      'video-mutation-repository', 'multipart-upload-repository'].map(name => `persistence/contracts/${name}`),
  ].map(name => resolve(cwd, 'src', `${name}.ts`)));
  const visited = new Set<string>();
  async function visit(filePath: string): Promise<void> {
    if (visited.has(filePath)) return;
    visited.add(filePath);
    expect(pureFiles.has(filePath) || filePath.startsWith(resolve(cwd, 'src/application') + '/') || filePath.startsWith(resolve(cwd, 'src/persistence/contracts') + '/'), filePath).toBe(true);
    const source = readFileSync(filePath, 'utf8');
    const [result] = await eslint.lintText(source, { filePath });
    expect(result.messages.filter(m => m.ruleId === 'no-restricted-imports' || m.ruleId === 'no-restricted-syntax'), filePath).toEqual([]);
    const tree = ts.createSourceFile(filePath, source, ts.ScriptTarget.Latest, true);
    for (const statement of tree.statements) {
      if (!(ts.isImportDeclaration(statement) || ts.isExportDeclaration(statement)) || !statement.moduleSpecifier) continue;
      expect(ts.isStringLiteral(statement.moduleSpecifier)).toBe(true);
      const dependency = (statement.moduleSpecifier as ts.StringLiteral).text;
      if (dependency.startsWith('.')) await visit(resolve(dirname(filePath), `${dependency}.ts`));
      else expect(dependency.startsWith('@videoq/domain/'), `${filePath}: external dependency`).toBe(true);
    }
  }
  for (const root of roots) await visit(resolve(cwd, 'src', `${root}.ts`));
  async function inspectDirectory(directory: string): Promise<void> {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = resolve(directory, entry.name);
      if (entry.isDirectory()) await inspectDirectory(path);
      else if (entry.isFile() && entry.name.endsWith('.ts')) await visit(path);
    }
  }
  for (const directory of ['application', 'persistence/contracts']) await inspectDirectory(resolve(cwd, 'src', directory));
});


it('keeps every shared domain module independent of transport and runtime implementations', () => {
  const root = fileURLToPath(new URL('../../../packages/domain/', import.meta.url));
  const manifest = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')) as { dependencies?: Record<string, string> };
  expect(Object.keys(manifest.dependencies ?? {})).toEqual([]);
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
          expect(dependency.startsWith('.'), `${path}: ${dependency}`).toBe(true);
          expect(resolve(directory, dependency).startsWith(resolve(root, 'src') + '/'), path).toBe(true);
        }
        expect(ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword, path).toBe(false);
        expect(ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'require', path).toBe(false);
        expect(ts.isImportTypeNode(node), path).toBe(false);
        ts.forEachChild(node, visit);
      }
      visit(tree);
    }
  }
  inspect(resolve(root, 'src'));
});

it('includes every ESLint-protected application module in the DOM-free compilation graph', async () => {
  const cwd = fileURLToPath(new URL('../', import.meta.url));
  const configPath = resolve(cwd, 'tsconfig.application.json');
  const config = ts.readConfigFile(configPath, ts.sys.readFile);
  expect(config.error).toBeUndefined();
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, cwd);
  const program = ts.createProgram(parsed.fileNames, parsed.options);
  const compiled = new Set(program.getSourceFiles().map(source => resolve(source.fileName)));
  expect([...compiled].some(path => /[/\\]lib\.dom(?:\.|\.d)/.test(path))).toBe(false);
  const eslint = new ESLint({ cwd, overrideConfig: [tseslint.configs.disableTypeChecked] });
  async function inspect(directory: string): Promise<void> {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = resolve(directory, entry.name);
      if (entry.isDirectory()) { await inspect(path); continue; }
      if (!path.endsWith('.ts')) continue;
      const rules = (await eslint.calculateConfigForFile(path))?.rules;
      const restriction = JSON.stringify(rules?.['no-restricted-imports']);
      if (restriction?.includes('Application workflows and their contracts') || restriction?.includes('Application models and persistence ports')) {
        expect(compiled.has(path), `Missing DOM-free application compilation: ${path}`).toBe(true);
      }
    }
  }
  await inspect(resolve(cwd, 'src'));
}, 30_000);

it('requires explicit operation time in invitation and maintenance workflows', async () => {
  const cwd = fileURLToPath(new URL('../', import.meta.url));
  const eslint = new ESLint({ cwd, overrideConfig: [tseslint.configs.disableTypeChecked] });
  for (const relativePath of [
    'src/application/course-invitations.ts',
    'src/features/course-memberships/core.ts',
    'src/features/course-memberships/delivery-service.ts',
    'src/features/maintenance/service.ts',
  ]) {
    for (const source of ['export const now = new Date();', 'export const now = Date.now();']) {
      const [result] = await eslint.lintText(source, { filePath: resolve(cwd, relativePath) });
      expect(result.messages.some(message => message.ruleId === 'no-restricted-syntax')).toBe(true);
    }
    const [allowed] = await eslint.lintText('export const timestamp = (time: number) => new Date(time);', {
      filePath: resolve(cwd, relativePath),
    });
    expect(allowed.errorCount, JSON.stringify(allowed.messages)).toBe(0);
  }
});
