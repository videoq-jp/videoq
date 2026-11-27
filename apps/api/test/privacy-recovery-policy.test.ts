import { expect, it } from 'vitest';
import { assertPrivacyRecovery} from '../src/application/privacy-policy';
import { privacyCatalogPage, privacySubjectsWithData, privacyCursorFailure, privacyRecordCursor,
  privacyCourseContext, privacyRecentContext, privacyReportContext, privacyRecordAllowed, privacyHistoryNeedsUpgrade,
  privacyErasurePlan, type PrivacyLogic } from '../src/domain/lms/privacy-policy';
import { privacyCollections } from '../src/domain/lms/privacy';
import { privacyIdentityPrefixes, courseQaAuthorInput, courseHistoryIdentityInput } from '../src/application/subject-identity';

it('denies stale authority before the legacy writer gate and allows independent recovery', () => {
  expect(() => assertPrivacyRecovery(false, false)).toThrow('Privacy request is unavailable.');
  expect(() => assertPrivacyRecovery(true, false)).toThrow('Drain older API writers');
  expect(() => assertPrivacyRecovery(true, true)).not.toThrow();
});

it('pages catalogs without exposing lookahead and keeps submitted subject order', () => {
  const rows = Array.from({ length: 101 }, (_, i) => `context-${i}`);
  expect(privacyCatalogPage(rows, value => value)).toEqual({ version: 1, collections: privacyCollections, contexts: rows.slice(0,100), nextAfter: rows[99] });
  expect(privacySubjectsWithData(['later','first','absent'], [true,true,false])).toEqual(['later','first']);
});

it('distinguishes retired conversation cursors from malformed typed cursors', () => {
  const uuid = 'known-uuid';const isUuid = (value: string) => value === uuid;
  expect(privacyCursorFailure('conversations','opaque',uuid,isUuid)).toBe('retiredConversation');
  expect(privacyCursorFailure('conversations','opaque','thread:key',isUuid)).toBeNull();
  expect(privacyCursorFailure('questions','uuid','bad',isUuid)).toBe('invalid');
  for (const id of ['0','-1','1.0','1 OR 1=1','1'.repeat(19)]) expect(privacyCursorFailure('logs','integer',id,isUuid)).toBe('invalid');
  expect(privacyCursorFailure('logs','integer','123',isUuid)).toBeNull();
  expect(privacyRecordCursor({ after:'older',record:{id:'current',offset:1,revision:'r'} })).toBe('current');
});

const logic: PrivacyLogic<string|null,boolean> = {
  and:(left,right)=>left&&right,or:(left,right)=>left||right,
  coalesce:(...values)=>values.find(value=>value!==null)??null,
  orphan:()=>'@orphan',choose:(condition,yes,no)=>condition?yes:no,
};
it('preserves mapping priority, explicit empty context and orphaned report attribution', () => {
  expect(privacyCourseContext('mapped','teaching',logic)).toBe('mapped');
  expect(privacyCourseContext(null,'teaching',logic)).toBe('teaching');
  expect(privacyCourseContext(null,null,logic)).toBe('@orphan');
  expect(privacyRecentContext('', 'fallback',logic)).toBe('');
  expect(privacyReportContext(false,true,'stored',logic)).toBe('stored');
  expect(privacyReportContext(false,false,'unbound',logic)).toBe('@orphan');
  expect(privacyRecordAllowed(false,true,true,logic)).toBe(false);
  expect(privacyRecordAllowed(true,false,false,logic)).toBe(false);
  expect(privacyRecordAllowed(true,false,true,logic)).toBe(true);
  expect(privacyHistoryNeedsUpgrade(false,true,true,logic)).toBe(false);
  expect(privacyHistoryNeedsUpgrade(true,false,true,logic)).toBe(true);
  expect(privacyHistoryNeedsUpgrade(true,false,false,logic)).toBe(false);
});

it('revokes feedback before its selectors disappear and anonymizes discussion structure', () => {
  const plan = privacyErasurePlan();const targets = plan.map(effect=>effect.target);
  expect(targets.indexOf('feedback')).toBeLessThan(targets.indexOf('sessions'));
  expect(targets.indexOf('sessions')).toBeLessThan(targets.indexOf('logs'));
  expect(targets).not.toContain('videos');expect(targets).not.toContain('users');
  expect(plan.find(effect=>effect.target==='questions')).toMatchObject({kind:'anonymize',fields:{title:'[deleted]',body:'[deleted]',author:'0'.repeat(64),featured:false,instructor:false}});
  expect(plan.find(effect=>effect.target==='moderation')).toEqual({target:'moderation',kind:'clearAttribution',actor:null});
});

it('retains byte-identical historical identity inputs and SQL prefixes', () => {
  const scope = { registrationId:'db:school"', subjectHash:'subject\\', courseId:7 };
  expect(courseQaAuthorInput(scope)).toBe(JSON.stringify(['lti-course-qa-v1',scope.registrationId,scope.subjectHash,scope.courseId]));
  expect(courseHistoryIdentityInput(scope)).toBe(JSON.stringify(['lti-course-history-v1',scope.registrationId,scope.subjectHash,scope.courseId]));
  const prefix = privacyIdentityPrefixes(scope);
  expect(prefix.qa+'7]').toBe(courseQaAuthorInput(scope));expect(prefix.history+'7]').toBe(courseHistoryIdentityInput(scope));
});
