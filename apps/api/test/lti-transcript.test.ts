import { describe, expect, it } from "vitest";
import { transcriptPage } from "../src/features/lti/transcript";
import { readServiceJson } from "../src/features/lti/materials-client";
import { coursePermissionsSchema } from "../src/features/lti/course-permissions";

describe("LTI transcript pagination", () => {
  it("does not infer transcript permission from future capability fields or truthy strings", () => {
    expect(coursePermissionsSchema.parse({ futureCapability: true })).toEqual({ viewTranscript: false });
    expect(coursePermissionsSchema.safeParse({ viewTranscript: "true" }).success).toBe(false);
  });
  it("keeps overlapping cues, skips malformed blocks, and terminates pagination", () => {
    const text = "bad cue\n\n1\n00:00:01,000 --> 00:00:02,000\nFirst\n\n2\n00:00:01,000 --> 00:00:03,000\nSecond\nline";
    expect(transcriptPage(text, 0, 1)).toMatchObject({ cues: [{ text: "First" }], nextCursor: 1 });
    expect(transcriptPage(text, 1, 1)).toMatchObject({ cues: [{ text: "Second\nline", startSeconds: 1 }], nextCursor: null });
    expect(transcriptPage(text, 2, 1)).toEqual({ cues: [], nextCursor: null });
    expect(transcriptPage(null, 0, 50)).toEqual({ cues: [], nextCursor: null });
  });
  it("cancels an oversized Moodle response before buffering the remaining stream", async () => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) { controller.enqueue(new Uint8Array(16)); },
      cancel() { cancelled = true; },
    });
    await expect(readServiceJson(new Response(body), 8)).rejects.toThrow("too large");
    expect(cancelled).toBe(true);
  });
});
