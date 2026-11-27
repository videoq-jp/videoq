import { expect, it, vi } from 'vitest';
import { createD1Fixture } from './d1-fixture';
import { courseSkillManagement } from '../../src/integrations/course-skill-management';
import { executeNextCourseSkillBuild } from '../../src/integrations/course-skill-execution';
import { createCourseSkillCandidateRepository } from '../../src/integrations/course-skill-candidates';
import type { Bindings } from '../../src/types/bindings';

const { generate } = vi.hoisted(() => ({ generate: vi.fn() }));
vi.mock('../../src/integrations/course-skill-model', () => ({ generateCourseSkillJson: generate }));

it.each([
  { mode: 'passes', totalCalls: 6, statuses: ['passed'], canPublish: true },
  { mode: 'still_unsupported', totalCalls: 8, statuses: ['held', 'held'], canPublish: false },
  { mode: 'provider_failure', totalCalls: 6, statuses: ['generation_failed', 'generation_failed'], canPublish: false },
])('persists bounded repair steps across leases: $mode', async ({ mode, totalCalls, statuses, canPublish }) => {
  const fixture = await createD1Fixture();
  const db = fixture.database;
  const sql = async (query: string, args: (string | number)[] = []) => { await db.prepare(query).bind(...args).run(); };
  const env = { DB: db, DEPLOYMENT_EDITION: 'cloud', PERSISTENCE_BACKEND: 'd1', LLM_MODEL: 'gpt-6-luna', OPENAI_API_KEY: 'synthetic-not-a-real-key', TASK_SCHEDULER: { getByName: () => ({ armAt: async () => undefined }) } } as unknown as Bindings;
  let audits = 0;
  generate.mockReset().mockImplementation(async (_env, _owner, options) => {
    const input = options.input;
    let value: unknown;
    switch (options.name) {
      case 'course_knowledge': value = { facts: ['principle', 'procedure', 'verification'].map(kind => ({ kind, claim: 'Keep the retry ID', appliesWhen: ['Retrying'], exceptions: [], evidence: [{ cueId: input.cues[0].id }], requiresVisualEvidence: false, versionContext: { language: '', framework: '', version: '' } })), verificationFacts: [] }; break;
      case 'skill_task_plan': value = { proposals: [{ existingSkillId: null, slug: 'review-retries', objective: 'Review retries', criterionFactIds: input.facts.filter((f: { kind: string }) => f.kind === 'principle').map((f: { id: string }) => f.id), procedureFactIds: input.facts.filter((f: { kind: string }) => f.kind === 'procedure').map((f: { id: string }) => f.id), verificationFactIds: input.facts.filter((f: { kind: string }) => f.kind === 'verification').map((f: { id: string }) => f.id), additionalFactIds: [] }], issues: [] }; break;
      case 'skill_draft': value = { slug: input.task.slug, title: 'Review retries', description: 'Review retry guarantees.', useWhen: ['Retrying'], doNotUseWhen: [], criteria: [{ decision: 'Keep the ID', factIds: [input.facts[0].id] }], steps: [{ action: 'Inspect IDs', expectedResult: 'The same retry ID', factIds: [input.facts[1].id] }], checks: [{ check: 'Compare IDs', factIds: [input.facts[2].id] }], exceptions: [], examples: [] }; break;
      case 'skill_draft_audit': audits++; value = mode === 'passes' && audits > 1 ? { supported: true, issues: [] } : { supported: false, issues: ['Check the expected retry behavior'] }; break;
      case 'skill_draft_revision':
        if (mode === 'provider_failure') throw new Error('SKILL_MODEL_GENERATION_FAILED');
        value = { ...input.draft, title: `Revised retry guide ${input.attempt}` }; break;
      default: throw new Error('Unexpected model stage');
    }
    return options.schema.parse(value);
  });
  try {
    await sql("INSERT INTO users(id,username,email,is_over_quota,used_ai_answers,used_processing_seconds,used_storage_bytes) VALUES('owner','owner','repair@example.test',0,0,0,0)");
    await sql("INSERT INTO videos(id,user_id,title,file,status,transcript,description,uploaded_at,error_message,source_type,source_url,youtube_video_id) VALUES(1,'owner','Fixture','fixture.mp4','completed',?,'','2026-11-28','','uploaded','','')", ['1\n00:00:01,000 --> 00:00:04,000\nKeep the same retry ID.']);
    await sql("INSERT INTO video_courses(id,user_id,name,description,created_at,updated_at,display_order) VALUES(1,'owner','Fixture','','2026-11-28','2026-11-28',0)");
    await sql("INSERT INTO video_course_members(course_id,video_id,added_at,\"order\") VALUES(1,1,'2026-11-28',0)");
    const owner = courseSkillManagement(env, 'owner');
    await owner.configure(1, { generationEnabled: true, distributionEnabled: false, language: 'en', policyVersion: '1' });
    let originalKnowledge = '';
    let completed = false;
    for (let tick = 0; tick < 16; tick++) {
      const before = generate.mock.calls.length;
      await executeNextCourseSkillBuild(env);
      expect(generate.mock.calls.length - before).toBeLessThanOrEqual(1);
      const knowledge = JSON.stringify((await db.prepare('SELECT key,content FROM course_skill_knowledge_chunks ORDER BY key').all()).results);
      if (!originalKnowledge) originalKnowledge = knowledge;
      else expect(knowledge).toBe(originalKnowledge);
      const state = await owner.list(1);
      expect(state.jobs[0].state, JSON.stringify({ calls: generate.mock.calls.map(call => call[2].name), error: state.jobs[0].error })).not.toBe('failed');
      if (state.jobs[0].state === 'completed') { completed = true; break; }
      await sql('UPDATE course_skill_builds SET lease_until=0');
    }
    expect(completed).toBe(true);
    expect(generate).toHaveBeenCalledTimes(totalCalls);
    expect(generate.mock.calls.filter(call => call[2].name === 'skill_draft_revision')).toHaveLength(statuses.length);
    const [candidate] = await (await createCourseSkillCandidateRepository(env)).list(1, 'owner');
    expect(candidate.content.generationRepair?.attempts.map(a => a.status)).toEqual(statuses);
    expect(candidate.content.generation?.draftPromptVersion).toBe('course-draft-v4-bounded-repair');
    expect(candidate.status).toBe('review_required');
    expect((await owner.list(1)).candidates[0].canPublish).toBe(canPublish);
    expect(await db.prepare('SELECT count(*) AS count FROM course_skill_publications').first('count')).toBe(0);
    if (!canPublish) expect(candidate.content.issues).toContain('SKILL_AUTO_REPAIR_EXHAUSTED');
    if (mode === 'provider_failure') expect(candidate.content.draft?.title).toBe('Review retries');
    const checkpoint = JSON.parse((await db.prepare('SELECT checkpoint FROM course_skill_builds WHERE id=?').bind(candidate.buildId).first<string>('checkpoint'))!);
    expect(checkpoint.modelCalls).toBe(totalCalls);
  } finally { await fixture.dispose(); }
}, 60_000);
