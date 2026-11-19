import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { ESLint } from "eslint";
import tseslint from "typescript-eslint";
import { readFileSync } from "node:fs";
import ts from "typescript";

it("prevents extracted use cases from acquiring runtime and implementation dependencies", async () => {
  const cwd = fileURLToPath(new URL("../", import.meta.url));
  const eslint = new ESLint({
    cwd,
    // Import restrictions are syntax rules. Avoid rebuilding typed projects for
    // synthetic sources; the repository lint command still checks all type rules.
    overrideConfig: [tseslint.configs.disableTypeChecked],
  });
  for (const relativePath of [
    "src/features/qa/policy.ts", "src/features/qa/core.ts", "src/features/teaching/core.ts", "src/features/lms/upload-service.ts", "src/features/videos/upload-service.ts",
    "src/features/courses/service.ts", "src/features/chat/service.ts", "src/features/chat/conversation-service.ts",
    "src/features/chat/generation-service.ts", "src/features/chat/generation-ports.ts",
    "src/features/videos/management-service.ts", "src/features/videos/management-ports.ts",
    "src/features/membership/core.ts", "src/features/billing/account-deletion-service.ts",
    "src/features/billing/service.ts", "src/features/billing/ports.ts", "src/application/errors.ts",
  ]) {
    const filePath = resolve(cwd, relativePath);
    for (const source of [
      'export { videoUploadService } from "../../integrations/video-upload";',
      'export type { Bindings } from "../../types/bindings";',
      'export { createQaRepository } from "../../persistence/factory";',
      'export { createD1QaRepository } from "../../persistence/d1/qa-repository";',
      'export { ApiError } from "../../shared/errors";',
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
    const [allowed] = await eslint.lintText('export type { VideoUploadRepository } from "../../persistence/contracts/video-upload-repository";', { filePath });
    expect(allowed.errorCount, JSON.stringify(allowed.messages)).toBe(0);
  }
}, 30_000);

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
  const roots = [
    'features/lms/upload-service', 'features/teaching/core', 'features/qa/core', 'features/qa/service', 'features/qa/policy', 'features/videos/upload-service',
    'features/courses/service', 'features/chat/service', 'features/chat/conversation-service',
    'features/billing/service', 'features/chat/generation-service',
    'features/videos/management-service', 'features/membership/core', 'features/billing/account-deletion-service',
  ];
  const pureFiles = new Set([
    ...roots, 'features/billing/catalog', 'features/billing/ports',
    'features/chat/generation-ports', 'features/videos/management-ports',
    'lib/upload', 'lib/share-slug', 'shared/csv', 'lib/youtube',
    ...['ai-quota', 'membership-repository', 'qa-repository', 'billing-repository', 'course-repository', 'conversation-read', 'chat-repository',
      'lti-subject', 'creation-idempotency', 'video-read-repository', 'video-upload-repository',
      'video-mutation-repository', 'multipart-upload-repository'].map(name => `persistence/contracts/${name}`),
  ].map(name => resolve(cwd, 'src', `${name}.ts`)));
  const visited = new Set<string>();
  async function visit(filePath: string): Promise<void> {
    if (visited.has(filePath)) return;
    visited.add(filePath);
    expect(pureFiles.has(filePath) || filePath.startsWith(resolve(cwd, 'src/application') + '/'), filePath).toBe(true);
    const source = readFileSync(filePath, 'utf8');
    const [result] = await eslint.lintText(source, { filePath });
    expect(result.messages.filter(m => m.ruleId === 'no-restricted-imports' || m.ruleId === 'no-restricted-syntax'), filePath).toEqual([]);
    const tree = ts.createSourceFile(filePath, source, ts.ScriptTarget.Latest, true);
    for (const statement of tree.statements) {
      if (!(ts.isImportDeclaration(statement) || ts.isExportDeclaration(statement)) || !statement.moduleSpecifier) continue;
      expect(ts.isStringLiteral(statement.moduleSpecifier)).toBe(true);
      const dependency = (statement.moduleSpecifier as ts.StringLiteral).text;
      if (dependency.startsWith('.')) await visit(resolve(dirname(filePath), `${dependency}.ts`));
      else expect(dependency, `${filePath}: external dependency`).toBe('@videoq/trpc/video-upload');
    }
  }
  for (const root of roots) await visit(resolve(cwd, 'src', `${root}.ts`));
});
