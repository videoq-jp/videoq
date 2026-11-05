import { env } from "cloudflare:workers";
import { expect, it } from "vitest";
import { lmsUploadStream } from "../../src/features/lms/upload";

const source = (bytes: number[]) => new ReadableStream<Uint8Array>({
  start(controller) { controller.enqueue(new Uint8Array(bytes)); controller.close(); },
});

it("streams a bounded Moodle video into real R2 without buffering or losing its known length", async () => {
  const key = "lms-sync/" + crypto.randomUUID();
  try {
    await env.VIDEO_BUCKET.put(key, lmsUploadStream(source([1, 2, 3]), 3));
    const stored = await env.VIDEO_BUCKET.get(key);
    expect(Array.from(new Uint8Array(await stored!.arrayBuffer()))).toEqual([1, 2, 3]);
  } finally { await env.VIDEO_BUCKET.delete(key); }
});

it.each([{ bytes: [1, 2] }, { bytes: [1, 2, 3, 4] }])("rejects a Moodle stream whose length differs from its reservation ($bytes)", async ({ bytes }) => {
  await expect(new Response(lmsUploadStream(source(bytes), 3)).arrayBuffer()).rejects.toThrow();
});
