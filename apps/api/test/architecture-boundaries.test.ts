import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { ESLint } from "eslint";
import tseslint from "typescript-eslint";

it("prevents extracted use cases from acquiring runtime and implementation dependencies", async () => {
  const cwd = fileURLToPath(new URL("../", import.meta.url));
  const eslint = new ESLint({
    cwd,
    // Import restrictions are syntax rules. Avoid rebuilding typed projects for
    // synthetic sources; the repository lint command still checks all type rules.
    overrideConfig: [tseslint.configs.disableTypeChecked],
  });
  for (const relativePath of ["src/features/qa/policy.ts", "src/features/qa/core.ts", "src/features/videos/upload-service.ts"]) {
    const filePath = resolve(cwd, relativePath);
    for (const source of [
      'export { videoUploadService } from "../../integrations/video-upload";',
      'export type { Bindings } from "../../types/bindings";',
      'export { createQaRepository } from "../../persistence/factory";',
      'export { createD1QaRepository } from "../../persistence/d1/qa-repository";',
      'export { ApiError } from "../../shared/errors";',
      'export const load = () => import("../../integrations/video-upload");',
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
