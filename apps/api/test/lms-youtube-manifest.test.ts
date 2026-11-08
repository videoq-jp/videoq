import { describe, expect, it } from 'vitest';
import { resourceManifestSchema } from '../src/features/lms/resource';
import { materialsManifestSchema } from '../src/features/lti/materials-client';

const base = { generation: 1, contextId: '42', resourceLinkId: 'lti-1', title: 'Source', enabled: true };
const file = { filename: 'source.mp4', contentType: 'video/mp4', size: 3, contentHash: 'a'.repeat(40) };
const youtube = { ...base, kind: 'youtube', youtubeVideoId: 'abcDEF123_-' };
describe('typed Moodle source manifests', () => {
  it('keeps the original File canonical JSON unchanged', () => {
    const parsed = resourceManifestSchema.parse({ ...base, file });
    expect(JSON.stringify(parsed)).toBe(JSON.stringify({
      generation: 1, contextId: '42', resourceLinkId: 'lti-1', enabled: true, title: 'Source', file,
    }));
    expect(parsed).not.toHaveProperty('kind');
    expect(parsed).not.toHaveProperty('youtubeVideoId');
  });
  it('accepts provider identity and typed tombstones without arbitrary provider URLs', () => {
    expect(resourceManifestSchema.parse(youtube)).toEqual(youtube);
    expect(resourceManifestSchema.parse({ ...youtube, enabled: false, deleted: true, youtubeVideoId: undefined }))
      .toMatchObject({ kind: 'youtube', enabled: false, deleted: true });
    for (const input of [
      { ...youtube, file }, { ...youtube, sourceUrl: 'http://internal.invalid' },
      { ...youtube, youtubeVideoId: undefined }, { ...youtube, deleted: true },
      { ...base, file, youtubeVideoId: 'abcDEF123_-' },
      { ...base, kind: 'course', youtubeVideoId: 'abcDEF123_-' },
      { ...base, kind: 'course', file }, { ...base, kind: 'unknown' },
    ]) expect(resourceManifestSchema.safeParse(input).success).toBe(false);
    for (const id of ['-----------', '___________', 'short', 'abcDEF123_--', 'abcDEF123_/', 'abcDEF12\n_-', 'abcDEF123_-\n']) {
      expect(resourceManifestSchema.safeParse({ ...youtube, youtubeVideoId: id }).success).toBe(false);
    }
  });
  it('keeps source count, context and duplicate identity boundaries for mixed manifests', () => {
    const snapshot = { contextId: '42', complete: true, resources: [{ externalId: '20', manifest: youtube },
      { externalId: '21', manifest: { ...base, file, resourceLinkId: 'file-lti' } }] };
    expect(materialsManifestSchema.safeParse(snapshot).success).toBe(true);
    expect(materialsManifestSchema.safeParse({ ...snapshot, resources: [...snapshot.resources, snapshot.resources[0]] }).success).toBe(false);
    expect(materialsManifestSchema.safeParse({ ...snapshot, contextId: '43' }).success).toBe(false);
  });
});
