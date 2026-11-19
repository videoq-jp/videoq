import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { ESLint } from "eslint";

it("prevents extracted use cases from acquiring runtime and implementation dependencies", async () => {
  const cwd = fileURLToPath(new URL("../", import.meta.url));
  const eslint = new ESLint({
    cwd,
    // CI's single-run parser reads disk-backed ASTs. These probes intentionally
    // replace the same file's text repeatedly, so use its watch-program mode.
    overrideConfig: { languageOptions: { parserOptions: { disallowAutomaticSingleRunInference: true } } },
  });
  for (const relativePath of ["src/features/qa/policy.ts", "src/features/videos/upload-service.ts"]) {
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
