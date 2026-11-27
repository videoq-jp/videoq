import { describe, expect, it } from 'vitest';
import type { CourseSkillInputRepository, CourseSkillSettings } from '../../../src/persistence/contracts/course-skill-input-repository';
import { courseSkillInputService } from '../../../src/features/course-skills/input-service';
import type { CourseSkillKnowledgeRepository } from '../../../src/persistence/contracts/course-skill-knowledge-repository';
import type { CourseSkillCandidateRepository } from '../../../src/persistence/contracts/course-skill-candidate-repository';
import type { CourseSkillPublicationRepository } from '../../../src/persistence/contracts/course-skill-publication-repository';
import { renderCourseSkill } from '../../../src/domain/learning/course-skill-draft';
import type { SkillDraft } from '@videoq/domain/agent-skills';
import type { CourseSkillExecutionRepository } from '../../../src/persistence/contracts/course-skill-execution-repository';
import { runCourseSkillBuild, SkillStepBudgetExceeded } from '../../../src/features/course-skills/execution-service';

import { extractSkillKnowledge } from '../../../src/features/course-skills/knowledge-service';
import { generateCourseSkillDrafts } from '../../../src/features/course-skills/draft-service';
import { createMcpSkillsService } from '../../../src/features/mcp/skills-service';

export const enabledSkillSettings: CourseSkillSettings = { generationEnabled: true, distributionEnabled: false, policyVersion: '1', language: 'ja' };
export type SkillInputFixture = {
  repository: CourseSkillInputRepository;
  knowledge: CourseSkillKnowledgeRepository;
  candidates: CourseSkillCandidateRepository;
  publications: CourseSkillPublicationRepository;
  execution: CourseSkillExecutionRepository;
  execute(sql: string, values?: (string | number)[]): Promise<void>;
  jobs(): Promise<{ id: string; input: string }[]>;
  dispose(): Promise<void>;
};

export function courseSkillInputContract(name: string, fixture: () => Promise<SkillInputFixture>) {
  describe(name, () => {
    async function setup() {
      const f = await fixture();
      let now = 1000;
      const service = courseSkillInputService({ repository: f.repository, id: () => crypto.randomUUID(), now: () => now,
        hash: async value => [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)))].map(x => x.toString(16).padStart(2, '0')).join('') });
      return { ...f, service, advance: () => { now += 60_001; }, now: () => now,
        add: () => f.execute(`INSERT INTO video_course_members(course_id,video_id,added_at,"order") VALUES(1,1,'2026-11-27',0)`),
        ready: () => f.execute(`UPDATE videos SET status='completed',transcript='1\n00:00:01,000 --> 00:00:04,000\nSample knowledge' WHERE id=1`),
      };
    }
    for (const sequence of ['registered-first', 'processed-first']) it(`${sequence}: converges once without putting transcripts into jobs`, async () => {
      const f = await setup();
      try {
        expect(await f.service.configure(1, 'owner', enabledSkillSettings)).toBe(true);
        if (sequence === 'registered-first') { await f.add(); await f.service.reconcile(1, 'owner'); expect(await f.jobs()).toHaveLength(0); await f.ready(); }
        else { await f.ready(); await f.service.reconcile(1, 'owner'); expect(await f.jobs()).toHaveLength(0); await f.add(); }
        await Promise.all([f.service.reconcile(1, 'owner'), f.service.reconcile(1, 'owner')]);
        await f.service.reconcile(1, 'owner');
        const jobs = await f.jobs();
        expect(jobs).toHaveLength(1);
        expect(jobs[0].input).not.toContain('Sample knowledge');
        expect(JSON.parse(jobs[0].input).sources).toHaveLength(1);
      } finally { await f.dispose(); }
    });
    it('denies outsider settings and source reads; disabled courses do not create work', async () => {
      const f = await setup();
      try {
        await f.add(); await f.ready();
        expect(await f.service.configure(1, 'other', enabledSkillSettings)).toBe(false);
        expect(await f.repository.snapshot(1, 'other')).toBeNull();
        await f.service.configure(1, 'owner', { ...enabledSkillSettings, generationEnabled: false });
        await f.service.sweep();
        expect(await f.jobs()).toHaveLength(0);
        await f.service.configure(1, 'owner', enabledSkillSettings);
        expect(await f.jobs()).toHaveLength(1);
      } finally { await f.dispose(); }
    });
    it('recovers a lost notification with a due scan', async () => {
      const f = await setup();
      try {
        await f.service.configure(1, 'owner', enabledSkillSettings);
        await f.add(); await f.ready(); f.advance();
        expect(await f.service.sweep()).toEqual({ checked: 1, reconciled: 1 });
        expect(await f.jobs()).toHaveLength(1);
      } finally { await f.dispose(); }
    });
    it('fences removed or re-added membership before reconciliation', async () => {
      const f = await setup();
      try {
        await f.add(); await f.ready(); await f.service.configure(1, 'owner', enabledSkillSettings);
        const [job] = await f.jobs();
        const claim = await f.repository.claim(job.id, 'owner', 'lease-a', f.now(), 1000);
        expect(claim).not.toBeNull();
        await f.execute('DELETE FROM video_course_members WHERE course_id=1 AND video_id=1');
        expect(await f.repository.checkpoint(job.id, 'owner', 'lease-a', claim!.generation, 'cursor', f.now())).toBe(false);
        expect(await f.repository.complete(job.id, 'owner', 'lease-a', claim!.generation, f.now())).toBe(false);
        await f.add();
        expect(await f.repository.complete(job.id, 'owner', 'lease-a', claim!.generation, f.now())).toBe(false);
        await f.service.reconcile(1, 'owner');
        expect(await f.jobs()).toHaveLength(2);
      } finally { await f.dispose(); }
    });
    it('rejects a snapshot if sources change before commit', async () => {
      const f = await setup();
      try {
        await f.add(); await f.ready(); await f.service.configure(1, 'owner', enabledSkillSettings);
        const snapshot = await f.repository.snapshot(1, 'owner');
        await f.execute('DELETE FROM video_course_members WHERE course_id=1');
        expect(await f.repository.reconcile(snapshot!, { id: 'stale', inputKey: 'stale', input: '{}' }, f.now())).toBe(false);
        expect((await f.jobs()).map(j => j.id)).not.toContain('stale');
      } finally { await f.dispose(); }
    });
    it('creates a new build when sources return to a previously completed projection', async () => {
      const f = await setup();
      try {
        await f.add(); await f.ready(); await f.service.configure(1, 'owner', enabledSkillSettings);
        const [original] = await f.jobs();
        const initial = await f.repository.claim(original.id, 'owner', 'initial', f.now(), 1000);
        expect(initial).not.toBeNull();
        expect(await f.repository.checkpoint(original.id, 'owner', 'initial', initial!.generation, 'original-checkpoint', f.now())).toBe(true);
        expect(await f.repository.complete(original.id, 'owner', 'initial', initial!.generation, f.now())).toBe(true);
        await f.execute('DELETE FROM video_course_members WHERE course_id=1 AND video_id=1');
        await f.service.reconcile(1, 'owner');
        // Restore the exact source projection, including the membership ID.
        await f.execute(`INSERT INTO video_course_members(id,course_id,video_id,added_at,"order") VALUES(1,1,1,'2026-11-27',0)`);
        await f.service.reconcile(1, 'owner');
        await f.service.reconcile(1, 'owner');
        const jobs = await f.jobs();
        expect(jobs).toHaveLength(2);
        const restored = jobs.find(j => j.id !== original.id)!;
        const claimed = await f.repository.claim(restored.id, 'owner', 'restored', f.now(), 1000);
        expect(claimed).not.toBeNull();
        expect(claimed!.revision).toBeGreaterThan(initial!.revision);
        expect(claimed!.checkpoint).toBe('');
        const history = await f.execution.progress(1, 'owner');
        expect(history.find(b => b.id === original.id)).toMatchObject({ revision: initial!.revision, state: 'completed', checkpoint: 'original-checkpoint' });
      } finally { await f.dispose(); }
    });
    it('fences expired leases and preserves checkpoints across takeover', async () => {
      const f = await setup();
      try {
        await f.add(); await f.ready(); await f.service.configure(1, 'owner', enabledSkillSettings);
        const [job] = await f.jobs();
        expect(await f.repository.claim(job.id, 'other', 'outsider', f.now(), 1000)).toBeNull();
        const first = await f.repository.claim(job.id, 'owner', 'first', f.now(), 1000);
        expect(await f.repository.checkpoint(job.id, 'owner', 'first', first!.generation, 'chunk:3', f.now())).toBe(true);
        expect(await f.repository.claim(job.id, 'owner', 'busy', f.now(), 1000)).toBeNull();
        f.advance();
        const second = await f.repository.claim(job.id, 'owner', 'second', f.now(), 1000);
        expect(second?.checkpoint).toBe('chunk:3');
        expect(second!.generation).toBeGreaterThan(first!.generation);
        expect(await f.repository.complete(job.id, 'owner', 'first', first!.generation, f.now())).toBe(false);
        expect(await f.repository.complete(job.id, 'owner', 'second', second!.generation, f.now())).toBe(true);
      } finally { await f.dispose(); }
    });
    it('settings changes immediately invalidate a running job', async () => {
      const f = await setup();
      try {
        await f.add(); await f.ready(); await f.service.configure(1, 'owner', enabledSkillSettings);
        const [job] = await f.jobs();
        const first = await f.repository.claim(job.id, 'owner', 'first', f.now(), 1000);
        await f.service.configure(1, 'owner', { ...enabledSkillSettings, generationEnabled: false });
        expect(await f.repository.complete(job.id, 'owner', 'first', first!.generation, f.now())).toBe(false);
      } finally { await f.dispose(); }
    });
    it('distribution changes preserve generation identity, while explicit rebuild starts a new input epoch', async () => {
      const f = await setup();
      try {
        await f.add(); await f.ready(); await f.service.configure(1, 'owner', enabledSkillSettings);
        const [job] = await f.jobs(); const snapshot = (await f.repository.snapshot(1, 'owner'))!;
        const claim = await f.repository.claim(job.id, 'owner', 'lease', f.now(), 1000);
        await f.service.configure(1, 'owner', { ...enabledSkillSettings, distributionEnabled: true });
        expect(await f.jobs()).toHaveLength(1);
        expect(await f.repository.checkpoint(job.id, 'owner', 'lease', claim!.generation, 'still-running', f.now())).toBe(true);
        expect((await f.repository.snapshot(1, 'owner'))!.generationEpoch).toBe(snapshot.generationEpoch);
        await f.service.configure(1, 'owner', { ...enabledSkillSettings, distributionEnabled: true }, true);
        expect(await f.jobs()).toHaveLength(2);
        expect((await f.repository.snapshot(1, 'owner'))!.generationEpoch).toBeGreaterThan(snapshot.generationEpoch);
      } finally { await f.dispose(); }
    });
    it('persists bounded model steps and honors requeue delays and lease fencing', async () => {
      const f = await setup();
      try {
        await f.add(); await f.ready(); await f.service.configure(1, 'owner', enabledSkillSettings);
        const pending = await f.execution.pending(f.now()); expect(pending).not.toBeNull();
        const claim = await f.repository.claim(pending!.id, 'owner', 'lease', f.now(), 1000);
        const lease = { id: claim!.id, ownerId: 'owner', token: 'lease', generation: claim!.generation };
        expect(await f.execution.saveStep(lease, 'step-key', '{"decision":"cached"}', f.now())).toBe(true);
        expect(await f.execution.readStep(lease, 'step-key', f.now())).toBe('{"decision":"cached"}');
        expect(await f.execution.release(lease, 'checkpoint', 'queued', f.now(), 1000)).toBe(true);
        expect(await f.execution.pending(f.now())).toBeNull();
        f.advance();
        const next = await f.repository.claim(pending!.id, 'owner', 'next', f.now(), 1000);
        const replacement = { ...lease, token: 'next', generation: next!.generation };
        expect(await f.execution.readStep(replacement, 'step-key', f.now())).toBe('{"decision":"cached"}');
        expect(await f.execution.readStep(lease, 'step-key', f.now())).toBeNull();
        await f.execute('DELETE FROM video_course_members WHERE course_id=1');
        expect(await f.execution.readStep(replacement, 'step-key', f.now())).toBeNull();
        expect(await f.execution.saveStep(replacement, 'stale', '{}', f.now())).toBe(false);
      } finally { await f.dispose(); }
    });
    it('resumes extraction and planning across bounded ticks without counting budget yields as failures', async () => {
      const f = await setup();
      try {
        await f.add(); await f.ready(); await f.service.configure(1, 'owner', enabledSkillSettings);
        let drafted = false;
        const deps = { inputs: f.repository, execution: f.execution, id: () => crypto.randomUUID(), now: f.now,
          extract: (_lease: unknown, _input: unknown, _source: unknown, budget: { spent: number }) => { budget.spent++; return Promise.resolve({ status: 'completed' as const, keys: ['knowledge-key'] }); },
          draft: (_lease: unknown, _input: unknown, keys: string[], budget: { spent: number }) => { expect(keys).toEqual(['knowledge-key']); budget.spent++; if (!drafted) { drafted = true; return Promise.reject(new SkillStepBudgetExceeded()); } return Promise.resolve(); },
        };
        expect(await runCourseSkillBuild(deps)).toMatchObject({ claimed: 1, phase: 'planning', failed: false });
        f.advance(); expect(await runCourseSkillBuild(deps)).toMatchObject({ claimed: 1, phase: 'planning', failed: false });
        f.advance(); expect(await runCourseSkillBuild(deps)).toMatchObject({ claimed: 1, phase: 'review_required', failed: false });
        const [progress] = await f.execution.progress(1, 'owner');
        expect(progress.state).toBe('completed'); expect(JSON.parse(progress.checkpoint)).toMatchObject({ phase: 'review_required', attempts: 0, modelCalls: 3 });
      } finally { await f.dispose(); }
    });
    it('reads bounded source pages and fences cached knowledge after removal', async () => {
      const f = await setup();
      try {
        await f.add(); await f.ready(); await f.service.configure(1, 'owner', enabledSkillSettings);
        const [job] = await f.jobs();
        const claim = await f.repository.claim(job.id, 'owner', 'lease', f.now(), 1000);
        const lease = { id: job.id, ownerId: 'owner', token: 'lease', generation: claim!.generation };
        const source = (await f.repository.snapshot(1, 'owner'))!.sources[0];
        const page = await f.knowledge.readPage(lease, 1, 0, f.now());
        expect(page?.text).toContain('Sample knowledge');
        expect(page?.done).toBe(true);
        expect(await f.knowledge.visualSource?.(lease, 1, f.now())).toBeNull();
        expect(await f.knowledge.readPage({ ...lease, ownerId: 'other' }, 1, 0, f.now())).toBeNull();
        const chunk = { version: 1 as const, videoId: 1, analysisRevision: source.analysisRevision, chunkIndex: 0, cues: [], facts: [], model: 'fixture', promptVersion: '1' };
        expect(await f.knowledge.save(lease, 'knowledge-key', chunk, f.now())).toBe(true);
        expect(await f.knowledge.cached(lease, 'knowledge-key', f.now())).toEqual(chunk);
        await f.execute('DELETE FROM video_course_members WHERE course_id=1');
        expect(await f.knowledge.readPage(lease, 1, 0, f.now())).toBeNull();
        expect(await f.knowledge.cached(lease, 'knowledge-key', f.now())).toBeNull();
        expect(await f.knowledge.save(lease, 'other-key', chunk, f.now())).toBe(false);
      } finally { await f.dispose(); }
    });
    it('persists review candidates with owner access and optimistic edit guards', async () => {
      const f = await setup();
      try {
        await f.add(); await f.ready(); await f.service.configure(1, 'owner', enabledSkillSettings);
        const [job] = await f.jobs();
        const claim = await f.repository.claim(job.id, 'owner', 'lease', f.now(), 1000);
        const lease = { id: job.id, ownerId: 'owner', token: 'lease', generation: claim!.generation };
        const content = { task: { skillId: 'skill-a', slug: 'review-retry', objective: '再試行を調べる', factIds: [] }, draft: null, facts: [], issues: ['SKILL_INSUFFICIENT_TASK_KNOWLEDGE'] };
        expect(await f.candidates.save(lease, { id: 'candidate-a', content, contentHash: 'hash-a' }, f.now())).toBe(true);
        expect(await f.repository.complete(job.id, 'owner', 'lease', claim!.generation, f.now())).toBe(true);
        expect(await f.candidates.list(1, 'other')).toHaveLength(0);
        expect((await f.candidates.list(1, 'owner'))[0].content).toEqual(content);
        expect(await f.candidates.edit('candidate-a', 'owner', 'wrong-hash', content, 'hash-b')).toBe(false);
        expect(await f.candidates.edit('candidate-a', 'owner', 'hash-a', content, 'hash-b')).toBe(true);
        await expect(f.candidates.edit('candidate-a', 'owner', 'hash-b', { ...content, task: { ...content.task, skillId: 'foreign' } }, 'hash-c')).rejects.toThrow('SKILL_EVIDENCE_EDIT_FORBIDDEN');
        await f.execute('DELETE FROM video_course_members WHERE course_id=1');
        expect(await f.candidates.edit('candidate-a', 'owner', 'hash-b', content, 'hash-c')).toBe(false);
        expect(await f.candidates.save(lease, { id: 'stale', content, contentHash: 'hash-c' }, f.now())).toBe(false);
      } finally { await f.dispose(); }
    });
    async function staged() {
      const f = await setup();
      await f.add(); await f.ready(); await f.service.configure(1, 'owner', { ...enabledSkillSettings, distributionEnabled: true });
      const [job] = await f.jobs();
      const claim = await f.repository.claim(job.id, 'owner', 'lease', f.now(), 1000);
      const lease = { id: job.id, ownerId: 'owner', token: 'lease', generation: claim!.generation };
      const snapshot = (await f.repository.snapshot(1, 'owner'))!;
      const draft: SkillDraft = { slug: 'review-retry', title: '再試行を確認する', description: '再試行の実装レビュー', useWhen: ['再試行'], doNotUseWhen: [], criteria: [{ decision: '条件を確認', factIds: ['f1'] }], steps: [{ action: 'コードを調べる', expectedResult: '確認できる', factIds: ['f1'] }], exceptions: [], checks: [{ check: 'テストする', factIds: ['f1'] }], examples: [] };
      const facts = [{ id: 'f1', videoId: 1, analysisRevision: snapshot.sources[0].analysisRevision, cues: [{ id: 'cue-0', startMs: 1000, endMs: 4000, text: 'Sample knowledge' }], kind: 'principle' as const, claim: 'Sample knowledge', appliesWhen: [], exceptions: [], evidence: [{ cueId: 'cue-0', quote: 'Sample knowledge' }], requiresVisualEvidence: false, status: 'supported' as const, versionContext: { language: null, framework: null, version: null } }];
      const content = { task: { skillId: 'published-skill', slug: draft.slug, objective: draft.title, factIds: ['f1'] }, draft, facts, issues: [] };
      expect(await f.candidates.save(lease, { id: 'candidate', content, contentHash: 'reviewed-hash' }, f.now())).toBe(true);
      expect(await f.publications.approve('candidate', 'owner', 'reviewed-hash')).toBe(false);
      expect(await f.repository.complete(job.id, 'owner', 'lease', claim!.generation, f.now())).toBe(true);
      expect(await f.publications.approve('candidate', 'other', 'reviewed-hash')).toBe(false);
      expect(await f.publications.approve('candidate', 'owner', 'wrong-hash')).toBe(false);
      expect(await f.publications.approve('candidate', 'owner', 'reviewed-hash')).toBe(true);
      const rendered = renderCourseSkill(1, draft, facts);
      const files = [];
      for (const file of rendered.files) files.push({ ...file, size: new TextEncoder().encode(file.content).byteLength,
        digest: 'sha256:' + [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(file.content)))].map(n => n.toString(16).padStart(2, '0')).join('') });
      const publication = { id: 'publication', candidateId: 'candidate', expectedHash: 'reviewed-hash', name: rendered.name, description: rendered.description, sources: snapshot.sourceState, files };
      return { ...f, publication };
    }
    it('atomically publishes complete files, then immediately denies removed-source reads', async () => {
      const f = await staged();
      try {
        expect(await f.publications.stage('owner', f.publication)).toBe(true);
        expect(await f.publications.get('publication', 'owner')).toBeNull();
        expect(await f.publications.publish('publication', 'owner', 'reviewed-hash')).toBe(true);
        expect(await f.publications.publish('publication', 'owner', 'reviewed-hash')).toBe(true);
        expect(await f.publications.list('owner', 20, '')).toHaveLength(1);
        const page = await f.publications.page('owner', 20, '');
        expect(page.publications.map(p => p.id)).toEqual(['publication']);
        expect(page.catalogIds).toEqual(['publication']);
        expect(await f.publications.page('owner', 20, 'publication')).toEqual({ publications: [], catalogIds: ['publication'] });
        expect(await f.publications.page('other', 20, '')).toEqual({ publications: [], catalogIds: [] });
        expect(await f.publications.read('publication', 'SKILL.md', 'owner')).toEqual(f.publication.files[0]);
        expect(await f.publications.read('publication', 'SKILL.md', 'other')).toBeNull();
        expect(await f.publications.list('other', 20, '')).toHaveLength(0);
        await f.execute(`INSERT INTO video_course_members(course_id,video_id,added_at,"order") VALUES(1,2,'2026-11-27',1)`);
        expect(await f.publications.get('publication', 'owner')).not.toBeNull();
        await f.execute('DELETE FROM video_course_members WHERE course_id=1 AND video_id=1');
        expect(await f.publications.get('publication', 'owner')).toBeNull();
        expect(await f.publications.read('publication', 'SKILL.md', 'owner')).toBeNull();
        expect(await f.publications.read('publication', 'references/sources.md', 'owner')).toBeNull();
        expect(await f.publications.list('owner', 20, '')).toHaveLength(0);
        expect(await f.publications.page('owner', 20, '')).toEqual({ publications: [], catalogIds: [] });
      } finally { await f.dispose(); }
    });
    it('runs prepared sources through extraction, review, MCP retrieval and membership removal/re-addition', async () => {
      const f = await setup();
      try {
        await f.add(); await f.ready();
        await f.service.configure(1, 'owner', { ...enabledSkillSettings, distributionEnabled: true });
        const hash = async (value: string) => [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)))].map(n => n.toString(16).padStart(2, '0')).join('');
        let calls = 0;
        const dependencies = { inputs: f.repository, execution: f.execution, now: f.now, id: () => crypto.randomUUID(),
          extract: async (lease: Parameters<typeof f.knowledge.cached>[0], input: { settings: CourseSkillSettings }, source: Parameters<typeof extractSkillKnowledge>[1]['source']) => extractSkillKnowledge({ repository: f.knowledge, hash, now: f.now, model: 'fixture', promptVersion: '1', beforeModel: async () => { calls++; },
            extract: async cues => (['principle', 'procedure', 'verification'] as const).map(kind => ({ kind, claim: 'Sample knowledge', appliesWhen: ['Review retry behavior'], exceptions: [], evidence: [{ cueId: cues[0].id, quote: 'Sample knowledge' }], requiresVisualEvidence: false, versionContext: { language: null, framework: null, version: null } })),
          }, { lease, source, language: input.settings.language, policyVersion: '1', maxModelCalls: 1 }),
          draft: async (lease: Parameters<typeof f.knowledge.cached>[0], _input: unknown, keys: string[]) => {
            const chunks = await Promise.all(keys.map(key => f.knowledge.cached(lease, key, f.now())));
            const result = await generateCourseSkillDrafts({ id: () => 'e2e-skill',
              plan: async facts => ({ proposals: [{ existingSkillId: null, slug: 'review-retry', objective: 'Review retries', factIds: facts.map(f => f.id) }], issues: [] }),
              synthesize: async (task, facts) => ({ slug: task.slug, title: 'Review retries', description: 'Review retry guarantees before changing code.', useWhen: ['Review retries'], doNotUseWhen: [], criteria: [{ decision: 'Check assumptions', factIds: [facts[0].id] }], steps: [{ action: 'Inspect code', expectedResult: 'Guarantees documented', factIds: [facts[1].id] }], exceptions: [], checks: [{ check: 'Verify repeated requests', factIds: [facts[2].id] }], examples: [] }),
              audit: async () => ({ supported: true, issues: [] }),
            }, chunks.filter(c => c !== null));
            for (const content of result.candidates) expect(await f.candidates.save(lease, { id: 'e2e-candidate', content, contentHash: await hash(JSON.stringify(content)) }, f.now())).toBe(true);
          },
        };
        expect(await runCourseSkillBuild(dependencies)).toMatchObject({ phase: 'planning' });
        f.advance();
        expect(await runCourseSkillBuild(dependencies)).toMatchObject({ phase: 'review_required' });
        expect(calls).toBe(1);
        const [candidate] = await f.candidates.list(1, 'owner');
        expect(await f.publications.approve(candidate.id, 'owner', candidate.contentHash)).toBe(true);
        const rendered = renderCourseSkill(1, candidate.content.draft!, candidate.content.facts, 'en');
        const files = await Promise.all(rendered.files.map(async file => ({ ...file, size: new TextEncoder().encode(file.content).byteLength, digest: `sha256:${await hash(file.content)}` })));
        expect(await f.publications.stage('owner', { id: 'e2e-publication', candidateId: candidate.id, expectedHash: candidate.contentHash, name: rendered.name, description: rendered.description, sources: (await f.repository.snapshot(1, 'owner'))!.sourceState, files })).toBe(true);
        expect(await f.publications.publish('e2e-publication', 'owner', candidate.contentHash)).toBe(true);
        const mcp = createMcpSkillsService(f.publications, 'owner');
        const [entry] = (await mcp.list()).skills;
        expect((await mcp.read(entry.uri)).contents[0].text).toContain('## Verification');
        expect((await createMcpSkillsService(f.publications, 'other').list()).skills).toHaveLength(0);
        await f.execute('DELETE FROM video_course_members WHERE course_id=1 AND video_id=1');
        await expect(mcp.read(entry.uri)).rejects.toThrow('Unknown skill or file');
        await f.add();
        await expect(mcp.get(entry.uri)).rejects.toThrow('Unknown skill or file');
        await f.service.reconcile(1, 'owner');
        expect(await f.jobs()).toHaveLength(2);
      } finally { await f.dispose(); }
    });
    it('refuses an approval-to-publication race and mismatched manifest bytes', async () => {
      const f = await staged();
      try {
        await expect(f.publications.stage('owner', { ...f.publication, files: f.publication.files.map(file => ({ ...file, content: file.content + 'tampered' })) })).rejects.toThrow('INVALID_SKILL_FILE_MANIFEST');
        expect(await f.publications.stage('owner', f.publication)).toBe(true);
        await f.execute('DELETE FROM video_course_members WHERE course_id=1');
        expect(await f.publications.publish('publication', 'owner', 'reviewed-hash')).toBe(false);
        expect(await f.publications.get('publication', 'owner')).toBeNull();
      } finally { await f.dispose(); }
    });
    it('requires editing a rejected candidate before it can be approved again', async () => {
      const f = await staged();
      try {
        expect(await f.candidates.reject('candidate', 'owner', 'reviewed-hash')).toBe(true);
        expect(await f.publications.approve('candidate', 'owner', 'reviewed-hash')).toBe(false);
        expect(await f.publications.stage('owner', f.publication)).toBe(false);
      } finally { await f.dispose(); }
    });
    it('withdraws all URI access and never edits an already published candidate', async () => {
      const f = await staged();
      try {
        await f.publications.stage('owner', f.publication);
        await f.publications.publish('publication', 'owner', 'reviewed-hash');
        const [candidate] = await f.candidates.list(1, 'owner');
        expect(await f.candidates.edit(candidate.id, 'owner', candidate.contentHash, candidate.content, 'changed')).toBe(false);
        expect(await f.publications.withdraw(1, 'published-skill', 'other')).toBe(false);
        expect(await f.publications.withdraw(1, 'published-skill', 'owner')).toBe(true);
        expect(await f.publications.get('publication', 'owner')).toBeNull();
      } finally { await f.dispose(); }
    });
  });
}
