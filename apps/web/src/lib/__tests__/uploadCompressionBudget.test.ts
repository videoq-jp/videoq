import { describe, expect, it } from 'vitest';
import { MAX_VIDEO_UPLOAD_BYTES } from '@videoq/domain/video-upload';
import { compressedUploadExceedsBudget, uploadCompressionBudget } from '@/application/video-upload';

describe('upload compression budget', () => {
  const reset = '2026-11-01T00:00:00Z';
  const now = Date.parse(reset);
  it('expires cached monthly usage exactly at reset without resetting storage usage', () => {
    const quota = { storageLimitBytes: 100, storageUsedBytes: 40, monthlyLimitBytes: 50, monthlyUsedBytes: 50, uploadResetsAt: reset };
    expect(uploadCompressionBudget(quota, now - 1)).toEqual({ maxBytes: 0, blockedBy: 'monthly' });
    expect(uploadCompressionBudget(quota, now)).toEqual({ maxBytes: 50, blockedBy: null });
    expect(uploadCompressionBudget({ ...quota, uploadResetsAt: 'invalid' }, now)).toEqual({ maxBytes: 0, blockedBy: 'monthly' });
  });
  it('keeps provider bounds for unlimited plans and prioritizes exhausted storage', () => {
    expect(uploadCompressionBudget({}, now)).toEqual({ maxBytes: MAX_VIDEO_UPLOAD_BYTES, blockedBy: null });
    expect(uploadCompressionBudget({ storageLimitBytes: 0, monthlyLimitBytes: 0 }, now)).toEqual({ maxBytes: 0, blockedBy: 'storage' });
    expect(uploadCompressionBudget({ storageLimitBytes: 100, storageUsedBytes: 30, monthlyLimitBytes: 100, monthlyUsedBytes: 90 }, now)).toEqual({ maxBytes: 10, blockedBy: null });
    expect(compressedUploadExceedsBudget(10, 10)).toBe(false);
    expect(compressedUploadExceedsBudget(11, 10)).toBe(true);
  });
});
