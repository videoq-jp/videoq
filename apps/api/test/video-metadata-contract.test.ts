import { expect, it } from 'vitest';
import { z } from 'zod';
import { inputSchemas } from '@videoq/trpc/inputs';
import { MAX_SINGLE_UPLOAD_BYTES, videoTitleFailure, uploadSizeFailure } from '@videoq/domain/video-upload';
import { managementToolSchemas } from '../src/tools/management';
const base = { filename: 'lesson.mp4', contentType: 'video/mp4', fileSize: 100, title: 'Lesson' };
const rpc = (input: typeof base) => inputSchemas['videos.requestUpload'].safeParse(input);
const mcp = (input: typeof base) => managementToolSchemas.request_video_upload.safeParse({
  idempotency_key: 'test-key-123', filename: input.filename, content_type: input.contentType, file_size: input.fileSize, title: input.title,
});
it.each([
  { title: '   ' }, { title: '😀'.repeat(128) }, { filename: 'lesson.exe' },
  { contentType: 'text/plain' }, { fileSize: 0 }, { fileSize: 0.1 }, { fileSize: Number.NaN },
])('enforces one metadata contract across tRPC and MCP: %j', patch => {
  const input = { ...base, ...patch };
  expect(rpc(input).success).toBe(false);
  expect(mcp(input).success).toBe(false);
});
it('normalizes metadata identically and preserves the explicit single PUT boundary', () => {
  const input = { ...base, title: ' Lesson ', filename: ' lesson.mp4 ', contentType: ' video/mp4 ' };
  expect(rpc(input)).toMatchObject({ success: true, data: base });
  expect(mcp(input)).toMatchObject({ success: true, data: { title: 'Lesson', filename: 'lesson.mp4', content_type: 'video/mp4' } });
  expect(videoTitleFailure('😀'.repeat(127) + 'a')).toBeNull();
  expect(uploadSizeFailure(MAX_SINGLE_UPLOAD_BYTES, true)).toBeNull();
  expect(uploadSizeFailure(MAX_SINGLE_UPLOAD_BYTES + 1, true)).not.toBeNull();
  expect(uploadSizeFailure(MAX_SINGLE_UPLOAD_BYTES + 1, false)).toBeNull();
});
it('keeps SDK tool schemas convertible to JSON Schema', () => {
  for (const schema of Object.values(managementToolSchemas)) expect(() => z.toJSONSchema(schema, { io: 'input' })).not.toThrow();
});
