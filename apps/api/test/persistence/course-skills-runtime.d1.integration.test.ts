import { expect, it, vi } from 'vitest';
import type { Bindings } from '../../src/types/bindings';
import { createD1Fixture } from './d1-fixture';
import { courseSkillManagement } from '../../src/integrations/course-skill-management';
import { executeNextCourseSkillBuild } from '../../src/integrations/course-skill-execution';
import { createCourseSkillPublicationRepository } from '../../src/integrations/course-skill-publications';
import { createMcpSkillsService } from '../../src/features/mcp/skills-service';

const { generate } = vi.hoisted(() => ({ generate: vi.fn() }));
vi.mock('../../src/integrations/course-skill-model', () => ({ generateCourseSkillJson: generate }));

it('integrates runtime factories, metered ticks, owner review and live MCP revocation', async () => {
  const f = await createD1Fixture();
  const sql = async (value: string, args: (string | number)[] = []) => { await f.database.prepare(value).bind(...args).run(); };
  const env = { DB: f.database, PERSISTENCE_BACKEND: 'd1', DEPLOYMENT_EDITION: 'cloud', TASK_SCHEDULER: { getByName: () => ({ armAt: async () => undefined }) }, OPENAI_API_KEY: 'synthetic-not-a-real-key', LLM_MODEL: 'gpt-6-luna' } as Bindings;
  generate.mockReset().mockImplementation(async (_env, _owner, options) => {
    const input = options.input;
    let result: unknown;
    switch (options.name) {
      case 'course_knowledge': result = { facts: ['principle', 'procedure', 'verification'].map(kind => ({ kind, claim: 'Check retry guarantees', appliesWhen: ['Changing retries'], exceptions: [], evidence: [{ cueId: input.cues[0].id, quote: input.cues[0].text }], requiresVisualEvidence: false, versionContext: { language: null, framework: null, version: null } })) }; break;
      case 'skill_task_plan': result = { proposals: [{ existingSkillId: input.existing[0]?.skillId ?? null, slug: 'review-retry', objective: 'Review retries', criterionFactIds: input.facts.filter((f: { kind: string }) => f.kind === 'principle').map((f: { id: string }) => f.id), procedureFactIds: input.facts.filter((f: { kind: string }) => f.kind === 'procedure').map((f: { id: string }) => f.id), verificationFactIds: input.facts.filter((f: { kind: string }) => f.kind === 'verification').map((f: { id: string }) => f.id), additionalFactIds: [] }], issues: [] }; break;
      case 'skill_draft': result = { slug: input.task.slug, title: 'Review retries', description: 'Review retry guarantees before changing code.', useWhen: ['Changing retries'], doNotUseWhen: [], criteria: [{ decision: 'Check assumptions', factIds: [input.facts[0].id] }], steps: [{ action: 'Inspect code', expectedResult: 'Known guarantees', factIds: [input.facts[1].id] }], exceptions: [], checks: [{ check: 'Repeat the request', factIds: [input.facts[2].id] }], examples: [] }; break;
      case 'skill_draft_audit': result = { supported: true, issues: [] }; break;
      default: throw new Error('Unexpected generation stage');
    }
    return options.schema.parse(result);
  });
  try {
    for (const id of ['owner', 'other']) await sql('INSERT INTO users(id,username,email,is_over_quota,used_ai_answers,used_processing_seconds,used_storage_bytes) VALUES(?,?,?,0,0,0,0)', [id, id, `${id}@example.test`]);
    await sql("INSERT INTO videos(id,user_id,title,file,status,transcript,description,uploaded_at,error_message,source_type,source_url,youtube_video_id) VALUES(1,'owner','Lecture','lecture.mp4','completed',?,'','2026-11-27','','uploaded','','')", ['1\n00:00:01,000 --> 00:00:04,000\nKeep the same request ID when retrying.']);
    await sql("INSERT INTO video_courses(id,user_id,name,description,created_at,updated_at,display_order) VALUES(1,'owner','Course','','2026-11-27','2026-11-27',0)");
    await sql('INSERT INTO video_course_members(course_id,video_id,added_at,"order") VALUES(1,1,?,0)', ['2026-11-27']);
    const owner = courseSkillManagement(env, 'owner');
    expect((await owner.list(1)).settings.generationEnabled).toBe(false);
    await expect(courseSkillManagement(env, 'other').configure(1, { generationEnabled: true, distributionEnabled: true, language: 'en', policyVersion: '1' })).rejects.toMatchObject({ kind: 'not_found' });
    await owner.configure(1, { generationEnabled: true, distributionEnabled: true, language: 'en', policyVersion: '1' });
    async function finish() {
      for (let tick = 0; tick < 12; tick++) {
        const before = generate.mock.calls.length;
        await executeNextCourseSkillBuild(env);
        expect(generate.mock.calls.length - before).toBeLessThanOrEqual(1);
        const state = await owner.list(1);
        if (state.jobs[0].state === 'completed') return state;
        expect(state.jobs[0].state).not.toBe('failed');
        await sql('UPDATE course_skill_builds SET lease_until=0');
      }
      throw new Error('Build failed to finish within fixture budget');
    }
    const initial = await finish();
    expect(generate).toHaveBeenCalledTimes(4);
    expect(initial.candidates[0].canPublish).toBe(true);
    const reviewed = await owner.get(1, initial.candidates[0].id);
    expect(reviewed.sources[0].quote).toContain('same request ID');
    expect(reviewed.files[0].content).toContain('## Verification');
    const published = await owner.publish(1, reviewed.id, reviewed.contentHash);
    expect(await owner.publish(1, reviewed.id, reviewed.contentHash)).toEqual(published);
    const repository = await createCourseSkillPublicationRepository(env);
    const mcp = createMcpSkillsService(repository, 'owner');
    const [entry] = (await mcp.list()).skills;
    expect((await mcp.read(entry.uri)).contents[0].text).toContain('Review retries');
    await owner.configure(1, { ...initial.settings, distributionEnabled: false });
    expect((await mcp.list()).skills).toHaveLength(0);
    expect((await owner.list(1)).revision).toBe(initial.revision);
    await owner.configure(1, initial.settings);
    await owner.rebuild(1);
    const rebuilt = await finish();
    expect(generate).toHaveBeenCalledTimes(7);
    const next = await owner.get(1, rebuilt.candidates[0].id);
    expect(next.previousDraft?.title).toBe('Review retries');
    await expect(owner.update(1, next.id, 'stale-hash', next.draft!)).rejects.toMatchObject({ kind: 'conflict' });
    await owner.update(1, next.id, next.contentHash, { ...next.draft!, title: 'Check retries before editing' });
    const edited = await owner.get(1, next.id);
    expect(edited.contentHash).not.toBe(next.contentHash);
    await owner.publish(1, edited.id, edited.contentHash);
    expect((await mcp.list()).skills[0].uri).not.toBe(entry.uri);
    await sql('DELETE FROM video_course_members WHERE course_id=1 AND video_id=1');
    await expect(mcp.read(entry.uri)).rejects.toThrow('Unknown skill or file');
    expect((await owner.list(1)).candidates[0].publication?.validSources).toBe(false);
    await owner.withdraw(1, edited.skillId);
    expect((await mcp.list()).skills).toHaveLength(0);
  } finally { await f.dispose(); }
}, 60_000);
