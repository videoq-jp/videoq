import { expect, it } from "vitest";
import { ESLint } from "eslint";

it("prevents extracted use cases from acquiring runtime and implementation dependencies", async () => {
  const eslint = new ESLint();
  for (const filePath of ["src/features/qa/policy.ts", "src/features/videos/upload-service.ts"]) {
    for (const source of [
      'export { videoUploadService } from "../../integrations/video-upload";',
      'export type { Bindings } from "../../types/bindings";',
      'export { createQaRepository } from "../../persistence/factory";',
      'export { createD1QaRepository } from "../../persistence/d1/qa-repository";',
      'export { ApiError } from "../../shared/errors";',
      'export const load = () => import("../../integrations/video-upload");',
    ]) {
      const [result] = await eslint.lintText(source, { filePath });
      expect(result.messages.some(message => message.ruleId === "no-restricted-imports" || message.ruleId === "no-restricted-syntax"), source).toBe(true);
    }
    const [allowed] = await eslint.lintText('export type { VideoUploadRepository } from "../../persistence/contracts/video-upload-repository";', { filePath });
    expect(allowed.errorCount, JSON.stringify(allowed.messages)).toBe(0);
  }
}, 30_000);
