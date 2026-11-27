import { expect, it } from 'vitest';
import { validResourceManifestSource, type ResourceManifest } from '../src/domain/lms/lms-resource';

type Source = Parameters<typeof validResourceManifestSource>[0];
const file: NonNullable<ResourceManifest['file']> = { filename: 'source.mp4', contentType: 'video/mp4', size: 3, contentHash: 'a'.repeat(40) };
const cases: Array<{ name: string; source: Source; valid: boolean }> = [
  { name: 'enabled file', source: { enabled: true, file, transcriptionLanguage: 'ja' }, valid: true },
  { name: 'missing enabled file', source: { enabled: true }, valid: false },
  { name: 'disabled file tombstone', source: { enabled: false, deleted: true }, valid: true },
  { name: 'enabled deleted file', source: { enabled: true, deleted: true, file }, valid: false },
  { name: 'file with YouTube identity', source: { enabled: false, file, youtubeVideoId: 'abcdefghijk' }, valid: false },
  { name: 'course entry', source: { enabled: true, kind: 'course' }, valid: true },
  { name: 'course with file', source: { enabled: false, kind: 'course', file }, valid: false },
  { name: 'course with YouTube identity', source: { enabled: false, kind: 'course', youtubeVideoId: 'abcdefghijk' }, valid: false },
  { name: 'course with transcription language', source: { enabled: false, kind: 'course', transcriptionLanguage: 'ja' }, valid: false },
  { name: 'enabled deleted course', source: { enabled: true, deleted: true, kind: 'course' }, valid: false },
  { name: 'enabled YouTube', source: { enabled: true, kind: 'youtube', youtubeVideoId: 'abcdefghijk' }, valid: true },
  { name: 'missing enabled YouTube identity', source: { enabled: true, kind: 'youtube' }, valid: false },
  { name: 'disabled YouTube tombstone', source: { enabled: false, deleted: true, kind: 'youtube' }, valid: true },
  { name: 'YouTube with file', source: { enabled: false, kind: 'youtube', file }, valid: false },
  { name: 'YouTube with transcription language', source: { enabled: false, kind: 'youtube', transcriptionLanguage: 'ja' }, valid: false },
  { name: 'enabled deleted YouTube', source: { enabled: true, deleted: true, kind: 'youtube', youtubeVideoId: 'abcdefghijk' }, valid: false },
];
it.each(cases)('preserves source eligibility for $name', ({ source, valid }) => {
  expect(validResourceManifestSource(source)).toBe(valid);
});
