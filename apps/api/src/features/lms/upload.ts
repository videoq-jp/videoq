import { LmsSyncError } from "./resource";

/** Bound bytes as they arrive and retain the known length required by R2.put. */
export function lmsUploadStream(body: ReadableStream<Uint8Array>, expected: number): ReadableStream<Uint8Array> {
  let received = 0;
  const bounded = body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      received += chunk.byteLength;
      if (received > expected) throw new LmsSyncError(413, "UPLOAD_SIZE_MISMATCH");
      controller.enqueue(chunk);
    },
    flush() { if (received !== expected) throw new LmsSyncError(400, "UPLOAD_SIZE_MISMATCH"); },
  }));
  return typeof FixedLengthStream === "undefined" ? bounded : bounded.pipeThrough(new FixedLengthStream(expected));
}
