import { describe, expect, it } from 'vitest';
import type { CourseSkillInputRepository, CourseSkillSettings } from '../../../src/persistence/contracts/course-skill-input-repository';
import { courseSkillInputService } from '../../../src/features/course-skills/input-service';

export const enabledSkillSettings: CourseSkillSettings = { generationEnabled: true, distributionEnabled: false, policyVersion: '1', language: 'ja' };
export type SkillInputFixture = {
  repository: CourseSkillInputRepository;
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
  });
}
