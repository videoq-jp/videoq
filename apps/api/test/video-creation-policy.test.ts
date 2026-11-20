import { expect, it } from 'vitest';
import { creationReceiptResult, validateCreationIdempotency } from '../src/application/creation-idempotency';
import { videoCreationReplayAllowed } from '../src/application/video-creation';

it('checks a stored request before allowing any receipt resource reuse', () => {
  expect(creationReceiptResult(undefined, 'expected')).toEqual({ found: false });
  expect(creationReceiptResult({ requestHash: 'different', resourceId: 7 }, 'expected')).toEqual({ found: true, conflict: true });
  expect(creationReceiptResult({ requestHash: 'expected', resourceId: 7 }, 'expected')).toEqual({ found: true, conflict: false, resourceId: 7 });
});
it('requires live upload reservations while retaining deleted YouTube creation identities', () => {
  expect(videoCreationReplayAllowed('uploaded', true, false)).toBe(false);
  expect(videoCreationReplayAllowed('uploaded', true, true)).toBe(true);
  expect(videoCreationReplayAllowed('youtube', true, false)).toBe(true);
  expect(videoCreationReplayAllowed('youtube', false, true)).toBe(false);
});
it('keeps creation action and receipt format validation independent of UUID allocation', () => {
  const receipt = { action: 'request_video_upload' as const, key: 'key', requestHash: 'a'.repeat(64) };
  expect(() => validateCreationIdempotency(undefined, 'create_youtube_video')).not.toThrow();
  expect(() => validateCreationIdempotency(receipt, 'request_video_upload')).not.toThrow();
  expect(() => validateCreationIdempotency(receipt, 'create_youtube_video')).toThrow('Invalid creation idempotency');
  expect(() => validateCreationIdempotency({ ...receipt, key: 'x'.repeat(129) }, receipt.action)).toThrow();
  expect(() => validateCreationIdempotency({ ...receipt, requestHash: 'A'.repeat(64) }, receipt.action)).toThrow();
});
