import { expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { CfWorkerJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/cfworker';
import { createVideoqMcpServer } from '../../src/features/mcp/server';
import { createMemoryRateLimitBackend } from '../../src/lib/rate-limit';
import type { Bindings } from '../../src/types/bindings';
import { createD1Fixture } from './d1-fixture';
import { courseSkillManagement } from '../../src/integrations/course-skill-management';
import { executeNextCourseSkillBuild } from '../../src/integrations/course-skill-execution';
import { createCourseSkillPublicationRepository, publishCourseSkillCandidate } from '../../src/integrations/course-skill-publications';
import { createMcpSkillsService } from '../../src/features/mcp/skills-service';
import { createCourseSkillInputs } from '../../src/integrations/course-skill-inputs';
import type { CourseSkillCandidateContent } from '../../src/persistence/contracts/course-skill-candidate-repository';
import { createCourseSkillCandidateRepository } from '../../src/integrations/course-skill-candidates';

const { generate } = vi.hoisted(() => ({ generate: vi.fn() }));
vi.mock('../../src/integrations/course-skill-model', () => ({ generateCourseSkillJson: generate }));

it('integrates runtime factories, metered ticks, owner review and live MCP revocation', async () => {
  const f = await createD1Fixture();
  const sql = async (value: string, args: (string | number)[] = []) => { await f.database.prepare(value).bind(...args).run(); };
  const env = { DB: f.database, RATE_LIMIT_BACKEND: createMemoryRateLimitBackend(), PERSISTENCE_BACKEND: 'd1', DEPLOYMENT_EDITION: 'cloud', TASK_SCHEDULER: { getByName: () => ({ armAt: async () => undefined }) }, OPENAI_API_KEY: 'synthetic-not-a-real-key', LLM_MODEL: 'gpt-6-luna' } as Bindings;
  async function compatibilityCall(userId: string, name: string, args: Record<string, unknown> = {}) {
    const server = createVideoqMcpServer({ env, userId, canWrite: false });
    const client = new Client({ name: 'legacy-skill-client', version: '1' }, { jsonSchemaValidator: new CfWorkerJsonSchemaValidator() });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    try {
      await server.connect(st); await client.connect(ct);
      return await client.callTool({ name, arguments: args });
    } finally { await client.close(); await server.close(); }
  }
  generate.mockReset().mockImplementation(async (_env, _owner, options) => {
    const input = options.input;
    let result: unknown;
    switch (options.name) {
      case 'course_knowledge': result = { facts: input.cues[0].text === 'No reusable knowledge.' ? [] : ['principle', 'procedure', 'verification'].map(kind => ({ kind, claim: 'Check retry guarantees', appliesWhen: ['Changing retries'], exceptions: [], evidence: [{ cueId: input.cues[0].id }], requiresVisualEvidence: false, versionContext: { language: '', framework: '', version: '' } })), verificationFacts: [] }; break;
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
    let initial = await finish();
    expect(generate).toHaveBeenCalledTimes(4);
    expect(initial.candidates[0].canPublish).toBe(true);
    const initialSkillId = initial.candidates[0].skillId;
    // Simulate an older persisted candidate that predates temporal image validation.
    // The public edit/save paths correctly refuse to create this state now.
    const stored = await f.database.prepare('SELECT content,content_hash FROM course_skill_candidates WHERE id=?').bind(initial.candidates[0].id).first<{ content: string; content_hash: string }>();
    expect(stored).not.toBeNull();
    const legacy = JSON.parse(stored!.content) as CourseSkillCandidateContent;
    legacy.facts[0].requiresVisualEvidence = true;
    legacy.facts[0].frames = [{ id: 'legacy-frame', timestampMs: 60000 }];
    legacy.facts[0].visualEvidence = [{ frameId: 'legacy-frame', observation: 'A fixture image outside the cited subtitle interval' }];
    const legacyText = JSON.stringify(legacy);
    const legacyHash = [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(legacyText)))].map(n => n.toString(16).padStart(2, '0')).join('');
    await sql('UPDATE course_skill_candidates SET content=?,content_hash=? WHERE id=?', [legacyText, legacyHash, initial.candidates[0].id]);
    const legacyReview = await owner.get(1, initial.candidates[0].id);
    expect(legacyReview).toMatchObject({ contentHash: legacyHash, issues: ['SKILL_INVALID_VISUAL_EVIDENCE'], files: [] });
    expect(legacyReview.sources.some(source => source.kind === 'image')).toBe(true);
    expect((await owner.list(1)).candidates[0].canPublish).toBe(false);
    await expect(owner.publish(1, legacyReview.id, legacyHash)).rejects.toMatchObject({ kind: 'conflict' });
    await expect(publishCourseSkillCandidate(env, { courseId: 1, candidateId: legacyReview.id, ownerId: 'owner', expectedHash: legacyHash })).rejects.toThrow('SKILL_INVALID_VISUAL_EVIDENCE');
    expect(await (await createCourseSkillPublicationRepository(env)).managed(1, 'owner')).toEqual([]);
    await expect(owner.reject(1, legacyReview.id, legacyHash)).resolves.toEqual({ success: true });
    expect((await owner.get(1, legacyReview.id)).status).toBe('rejected');
    await sql("UPDATE course_skill_candidates SET content=?,content_hash=?,status='review_required' WHERE id=?", [stored!.content, stored!.content_hash, legacyReview.id]);
    const unedited = await owner.get(1, initial.candidates[0].id);
    await owner.update(1, unedited.id, unedited.contentHash, { ...unedited.draft!, title: 'Owner-reviewed retry guide' });
    const originalReview = await owner.get(1, initial.candidates[0].id);
    // Rebinding existing review work must retain its actual generation version.
    const provenanceRow = await f.database.prepare('SELECT content FROM course_skill_candidates WHERE id=?').bind(originalReview.id).first<{ content: string }>();
    const priorContent = JSON.parse(provenanceRow!.content) as CourseSkillCandidateContent;
    priorContent.generation!.draftPromptVersion = 'legacy-reviewed-v1';
    const priorText = JSON.stringify(priorContent);
    const priorHash = [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(priorText)))].map(n => n.toString(16).padStart(2, '0')).join('');
    await sql('UPDATE course_skill_candidates SET content=?,content_hash=? WHERE id=?', [priorText, priorHash, originalReview.id]);
    await sql("INSERT INTO videos(id,user_id,title,file,status,transcript,description,uploaded_at,error_message,source_type,source_url,youtube_video_id) VALUES(2,'owner','Unrelated','unrelated.mp4','completed',?,'','2026-11-27','','uploaded','','')", ['1\n00:00:01,000 --> 00:00:04,000\nNo reusable knowledge.']);
    await sql('INSERT INTO video_course_members(course_id,video_id,added_at,"order") VALUES(1,2,?,1)', ['2026-11-27']);
    expect((await owner.list(1)).candidates[0].canPublish).toBe(false);
    await (await createCourseSkillInputs(env)).reconcile(1, 'owner');
    initial = await finish();
    // Extraction and planning only; unchanged prose and evidence need no new synthesis/audit.
    expect(generate).toHaveBeenCalledTimes(7);
    expect(initial.candidates[0]).toMatchObject({ skillId: initialSkillId, canPublish: true, editable: true });
    expect(initial.candidates[0].id).not.toBe(originalReview.id);
    expect((await owner.get(1, initial.candidates[0].id)).draft).toEqual(originalReview.draft);
    const rebound = await (await createCourseSkillCandidateRepository(env)).list(1, 'owner');
    expect(rebound.find(c => c.id === initial.candidates[0].id)?.content.generation).toEqual(priorContent.generation);
    const reviewed = await owner.get(1, initial.candidates[0].id);
    expect(reviewed.sources[0].quote).toContain('same request ID');
    expect(reviewed.files[0].content).toContain('## Verification');
    const published = await owner.publish(1, reviewed.id, reviewed.contentHash);
    expect(await owner.publish(1, reviewed.id, reviewed.contentHash)).toEqual(published);
    const repository = await createCourseSkillPublicationRepository(env);
    const mcp = createMcpSkillsService(repository, 'owner');
    const [entry] = (await mcp.list()).skills;
    expect((await mcp.read(entry.uri)).contents[0].text).toContain('Owner-reviewed retry guide');
    await owner.configure(1, { ...initial.settings, distributionEnabled: false });
    expect((await mcp.list()).skills).toHaveLength(0);
    expect((await owner.list(1)).revision).toBe(initial.revision);
    await owner.configure(1, initial.settings);
    await owner.rebuild(1);
    const rebuilt = await finish();
    expect(generate).toHaveBeenCalledTimes(10);
    const next = await owner.get(1, rebuilt.candidates[0].id);
    expect(next.previousDraft?.title).toBe('Owner-reviewed retry guide');
    await expect(owner.update(1, next.id, 'stale-hash', next.draft!)).rejects.toMatchObject({ kind: 'conflict' });
    const beforeInvalidEdit = generate.mock.calls.length;
    await expect(owner.update(1, next.id, next.contentHash, { ...next.draft!, doNotUseWhen: ['Unsourced prototype policy'] })).rejects.toMatchObject({ kind: 'invalid' });
    expect(generate.mock.calls.length).toBe(beforeInvalidEdit);
    expect((await owner.get(1, next.id)).contentHash).toBe(next.contentHash);
    await owner.update(1, next.id, next.contentHash, { ...next.draft!, title: 'Check retries before editing' });
    const edited = await owner.get(1, next.id);
    expect(edited.contentHash).not.toBe(next.contentHash);
    await owner.publish(1, edited.id, edited.contentHash);
    expect((await mcp.list()).skills[0].uri).not.toBe(entry.uri);
    const currentUri = (await mcp.list()).skills[0].uri;
    expect(await compatibilityCall('owner', 'list_course_skills')).toMatchObject({ structuredContent: { result: { skills: [{ uri: currentUri }] } } });
    expect(await compatibilityCall('other', 'list_course_skills')).toMatchObject({ structuredContent: { result: { skills: [] } } });
    expect(await compatibilityCall('owner', 'get_course_skill', { uri: currentUri })).toMatchObject({ structuredContent: { result: { skill: { uri: currentUri } } } });
    expect(await compatibilityCall('owner', 'read_course_skill_resource', { uri: currentUri })).toMatchObject({ structuredContent: { result: { contents: [{ text: expect.stringContaining('Check retries before editing') }] } } });
    expect(await compatibilityCall('other', 'read_course_skill_resource', { uri: currentUri })).toMatchObject({ isError: true, structuredContent: { code: 'SKILL_UNAVAILABLE' } });
    await sql('DELETE FROM video_course_members WHERE course_id=1 AND video_id=1');
    expect(await compatibilityCall('owner', 'list_course_skills')).toMatchObject({ structuredContent: { result: { skills: [] } } });
    expect(await compatibilityCall('owner', 'get_course_skill', { uri: currentUri })).toMatchObject({ isError: true, structuredContent: { code: 'SKILL_UNAVAILABLE' } });
    expect(await compatibilityCall('owner', 'read_course_skill_resource', { uri: currentUri })).toMatchObject({ isError: true, structuredContent: { code: 'SKILL_UNAVAILABLE' } });
    await expect(mcp.read(entry.uri)).rejects.toThrow('Unknown skill or file');
    expect((await owner.list(1)).candidates[0].publication?.validSources).toBe(false);
    await owner.withdraw(1, edited.skillId);
    expect((await mcp.list()).skills).toHaveLength(0);
  } finally { await f.dispose(); }
}, 60_000);
