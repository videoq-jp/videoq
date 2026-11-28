import { constants } from 'node:fs';
import { open } from 'node:fs/promises';

/** Inspect and read the same descriptor, refusing links, devices and oversized artifacts. */
export async function readBoundedRegularFile(path: string, maxBytes: number): Promise<Buffer> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const metadata = await file.stat();
    if (!metadata.isFile()) throw new Error('EVALUATION_ARTIFACT_NOT_REGULAR');
    if (metadata.size > maxBytes) throw new Error('EVALUATION_ARTIFACT_TOO_LARGE');
    const buffer = Buffer.alloc(maxBytes + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await file.read(buffer, length, buffer.length - length, null);
      if (!bytesRead) break;
      length += bytesRead;
    }
    if (length > maxBytes) throw new Error('EVALUATION_ARTIFACT_TOO_LARGE');
    return buffer.subarray(0, length);
  } finally { await file.close(); }
}
