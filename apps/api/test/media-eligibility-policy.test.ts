import { expect, it } from 'vitest';
import { learningVideoAllowed, linkedCourseAllowed, linkedLessonTitle, mediaBooleanLogic, reindexCandidateAllowed } from '../src/application/media-eligibility';
import { managementConnectionActive, managementSystemAdministrator } from '../src/application/lms-management';
it('limits learning media to completed owned videos', () => {
  expect(learningVideoAllowed(true,'completed',mediaBooleanLogic)).toBe(true);
  for(const status of ['processing','error','uploading','indexing','COMPLETED',null])expect(learningVideoAllowed(true,status,mediaBooleanLogic)).toBe(false);
  expect(learningVideoAllowed(false,'completed',mediaBooleanLogic)).toBe(false);
});
it('excludes null/empty transcripts while keeping whitespace for reindexing', () => {
  for(const transcript of [null,'',' ','\t\n','caption']) {
    expect(reindexCandidateAllowed('completed',transcript,mediaBooleanLogic)).toBe(transcript!==null&&transcript!=='');
    expect(reindexCandidateAllowed('processing',transcript,mediaBooleanLogic)).toBe(false);
  }
});
it('requires current teacher ownership, native access and active connection', () => {
  const facts={ownerMatches:true,nativeEnabled:true,connectionActive:true};
  expect(linkedCourseAllowed(facts,mediaBooleanLogic)).toBe(true);
  for(const key of Object.keys(facts) as (keyof typeof facts)[])expect(linkedCourseAllowed({...facts,[key]:false},mediaBooleanLogic)).toBe(false);
  expect(linkedLessonTitle('', 'Course')).toBe('Course');expect(linkedLessonTitle(null,'Course')).toBe('Course');
  expect(linkedLessonTitle(' ', 'Course')).toBe(' ');
});
it('keeps exact system administration separate from native comma-token roles', () => {
  expect(managementSystemAdministrator('admin')).toBe(true);
  for(const role of ['user,admin','admin,user','administrator','Admin',null])expect(managementSystemAdministrator(role)).toBe(false);
  for(const installation of [false,true])for(const teacher of [false,true])expect(managementConnectionActive(installation,teacher,mediaBooleanLogic)).toBe(installation&&teacher);
});
