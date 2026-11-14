import { AwsClient } from "aws4fetch";
import { expect, it, vi } from "vitest";
import { resolveFileUrl } from "../src/integrations/media";

it("does not log a signing failure that contains a private URL", async () => {
  const canary = "https://storage.example/private?signature=synthetic-private-signing-token";
  const sign = vi.spyOn(AwsClient.prototype, "sign").mockRejectedValueOnce(new Error(canary));
  const log = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    const result = await resolveFileUrl({ USE_S3_STORAGE: "true", R2_ACCESS_KEY_ID: "fixture", R2_SECRET_ACCESS_KEY: "fixture",
      R2_S3_ENDPOINT: "https://storage.example", R2_BUCKET_NAME: "fixture" } as never, "private.mp4");
    expect(sign).toHaveBeenCalledOnce();
    expect(result).toBeNull();
    expect(log).toHaveBeenCalledOnce();
    expect(JSON.stringify(log.mock.calls)).not.toContain(canary);
  } finally { sign.mockRestore(); log.mockRestore(); }
});
