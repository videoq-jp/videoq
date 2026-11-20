import { expect, it } from 'vitest';
import { activeMultipartSession, assertMultipartInitialization, multipartReservation, multipartPartLength,
  orderedMultipartParts, multipartObjectMatches, assertMultipartObjectSize, uploadConfirmed } from '../src/application/multipart-upload';

it('permits completion replay only after confirmation and refuses new session controls', () => {
  for (const status of ['pending', 'processing', 'indexing', 'completed', 'error']) {
    expect(uploadConfirmed(status)).toBe(true);
    expect(() => assertMultipartInitialization(status)).toThrow('already confirmed');
    expect(() => activeMultipartSession(status, { uploadId: 'old' })).toThrow('not active');
  }
  for (const status of ['uploading', '', 'unknown']) expect(uploadConfirmed(status)).toBe(false);
  const session = { uploadId: 'current' };
  expect(activeMultipartSession('uploading', session)).toBe(session);
  expect(() => activeMultipartSession('uploading', null)).toThrow('not active');
});

it('signs exact part lengths at boundaries and refuses invalid numbers', () => {
  const partSize = 64 * 1024 * 1024;
  expect(multipartPartLength(partSize, partSize, 1)).toBe(partSize);
  expect(multipartPartLength(partSize + 3, partSize, 2)).toBe(3);
  for (const part of [0, -1, 1.5, 3, NaN, Infinity])
    expect(() => multipartPartLength(partSize + 3, partSize, part)).toThrow('Invalid upload part number');
  expect(() => multipartPartLength(null, partSize, 1)).toThrow('Invalid upload part number');
  expect(() => multipartReservation(null)).toThrow('Upload reservation is missing');
});

it('orders a complete set without mutating client input or altering opaque ETags', () => {
  const parts = [{ partNumber: 2, etag: 'opaque_R2/token+=' }, { partNumber: 1, etag: 'first' }];
  expect(orderedMultipartParts(7, 4, parts)).toEqual([parts[1], parts[0]]);
  expect(parts[0].partNumber).toBe(2);
  expect(orderedMultipartParts(10000, 1, Array.from({ length: 10000 }, (_, i) => ({ partNumber: i + 1, etag: 'x' })))).toHaveLength(10000);
  expect(() => orderedMultipartParts(10001, 1, Array.from({ length: 10001 }, (_, i) => ({ partNumber: i + 1, etag: 'x' })))).toThrow('parts are missing or invalid');
});

it('refuses missing, duplicate, nonsequential and malformed completion parts before storage work', () => {
  for (const parts of [[], [{ partNumber: 1, etag: 'only' }], [{ partNumber: 1, etag: 'a' }, { partNumber: 1, etag: 'b' }],
    [{ partNumber: 1, etag: 'a' }, { partNumber: 3, etag: 'b' }], [{ partNumber: 1, etag: 'a' }, { partNumber: 2, etag: 'bad\nheader' }]])
    expect(() => orderedMultipartParts(7, 4, parts)).toThrow('parts are missing or invalid');
  expect(() => orderedMultipartParts(null, 4, [{ partNumber: 1, etag: 'valid' }])).toThrow('parts are missing or invalid');
});

it('recovers lost completion responses only for an exact reserved object size', () => {
  expect(multipartObjectMatches(5, 5)).toBe(true);
  for (const actual of [null, 0, 4, 6]) {
    expect(multipartObjectMatches(actual, 5)).toBe(false);
    expect(() => assertMultipartObjectSize(actual, 5)).toThrow('does not match the reserved size');
  }
});
