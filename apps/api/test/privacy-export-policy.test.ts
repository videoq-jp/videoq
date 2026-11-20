import { expect, it } from 'vitest';
import { privacyExportPage, privacyContextPage, PRIVACY_EXPORT_CHUNK_CHARACTERS } from '../src/application/privacy';

const row = { id: 'record', context: 'course', revision: 'r', total: 70000, chunk: 'data' };
it('continues an export at the exact character boundary and finishes with a record cursor', () => {
  expect(privacyExportPage(row)).toMatchObject({ part: { offset: 0 }, next: { record: { id: 'record', offset: PRIVACY_EXPORT_CHUNK_CHARACTERS, revision: 'r' } } });
  expect(privacyExportPage(row, { id: 'record', offset: 65536, revision: 'r' })).toMatchObject({ part: { offset: 65536 }, next: { after: 'record' } });
  expect(privacyExportPage({ ...row, total: 65536 })).toMatchObject({ next: { after: 'record' } });
});
it('rejects a changed, shortened, or disappeared record while accepting end of collection', () => {
  expect(privacyExportPage(row, { id: 'record', offset: 1, revision: 'old' })).toEqual({ changed: true });
  expect(privacyExportPage(row, { id: 'record', offset: 70000, revision: 'r' })).toEqual({ changed: true });
  expect(privacyExportPage(null, { id: 'record', offset: 1, revision: 'r' })).toEqual({ changed: true });
  expect(privacyExportPage(null)).toEqual({ part: null, next: null });
});
it('uses the last returned context as the continuation cursor without leaking the lookahead', () => {
  const contexts = Array.from({ length: 101 }, (_, i) => `course-${i}`);
  expect(privacyContextPage(contexts, value => value)).toEqual({ contexts: contexts.slice(0, 100), nextAfter: contexts[99] });
  expect(privacyContextPage(contexts.slice(0, 100), value => value).nextAfter).toBeNull();
});
