import { describe, it, expect, vi } from 'vitest';
import { createSkillService, type SkillDependencies } from '../src/features/skills/service';
import { skillChunks, checkedPlan, checkedFacts, checkedDraft, auditIssues, draftClaims } from '../src/features/skills/core';
import type { AgentSkillRecord, AgentSkillRepository } from '../src/persistence/contracts/agent-skill-repository';
import { skillMaterial, extractedSkillFacts, generatedSkillDraft, skillFixtureId } from './fixtures/agent-skill';

function setup() {
  const records = new Map<string, AgentSkillRecord>(), leases = new Map<string, string>();
  const repository: AgentSkillRepository = {
    async create(record) { records.set(record.id, structuredClone(record)); },
    async get(id, ownerId) { const record = records.get(id); return record?.ownerId === ownerId ? structuredClone(record) : null; },
    async claim(id, ownerId, token) { if (leases.has(id) || records.get(id)?.ownerId !== ownerId) return false; leases.set(id, token); return true; },
    async save(id, ownerId, token, state) { if (leases.get(id) !== token || records.get(id)?.ownerId !== ownerId) return false; records.set(id, { id, ownerId, state: structuredClone(state) }); return true; },
    async release(id, _owner, token) { if (leases.get(id) === token) leases.delete(id); },
  };
  let fingerprint = 'original';
  const deps: SkillDependencies = {
    repository, material: vi.fn().mockResolvedValue(skillMaterial), fingerprint: vi.fn(async () => fingerprint), newId: () => skillFixtureId, now: () => 0,
    plan: vi.fn().mockResolvedValue({ skills: [{ objective: 'Implement the lab API client', factIds: extractedSkillFacts.facts.map((_, i) => `chunk-0-fact-${i}`) }] }),
    extract: vi.fn().mockResolvedValue(extractedSkillFacts), synthesize: vi.fn().mockResolvedValue(generatedSkillDraft),
    audit: vi.fn().mockResolvedValue({ routingAppropriate: true, checks: draftClaims(generatedSkillDraft).map(claim => ({ claimId: claim.id, grounded: true, actionable: true, reason: 'The quoted instructor evidence supports this condition.' })) }),
  };
  const service = createSkillService(deps, 'https://videoq.example');
  const start = () => service.start('owner', { kind: 'course', resourceId: 42, objective: 'Implement the lab rate-limited API client', language: 'en' });
  return { deps, service, start, records, leases, changeSource: () => { fingerprint = 'changed'; } };
}

describe('generated agent skills', () => {
  it('extracts, synthesizes, checks, reviews and publishes concrete rules with exact timed evidence', async () => {
    const { service, start, deps } = setup();
    const started = await start();
    expect(started.stage).toBe('extracting'); expect(started.totalChunks).toBe(1);
    await expect(service.bundle('owner', started.id)).rejects.toThrow(/publish/);
    expect((await service.advance('owner', started.id)).stage).toBe('synthesizing');
    expect((await service.advance('owner', started.id)).stage).toBe('auditing');
    const review = await service.advance('owner', started.id);
    expect(review.stage).toBe('review'); expect(review.markdown).toContain('cap concurrent in-flight requests at two');
    expect(review.markdown).not.toContain('derive relevant lessons');
    await expect(service.bundle('owner', started.id)).rejects.toThrow(/publish/);
    await service.publish('owner', started.id);
    const bundle = await service.bundle('owner', started.id);
    expect(bundle.files['SKILL.md']).toContain('Do not sleep or retry in the helper');
    expect(bundle.files['references/sources.md']).toContain('00:00:10,000');
    expect(bundle.files['references/sources.md']).toContain('https://videoq.example/videos/7?t=10');
    expect(bundle.files['references/sources.md']).toContain(extractedSkillFacts.facts[1].evidence[0].quote);
    expect(deps.extract).toHaveBeenCalledTimes(1); expect(deps.audit).toHaveBeenCalledTimes(1);
    await service.advance('owner', started.id);
    expect(deps.audit).toHaveBeenCalledTimes(1);
  });
  it('discovers multiple tasks without a human objective and only exports the set after every member passes', async () => {
    const { service, deps } = setup();
    const source = { id: 8, title: 'SQL diagnosis', transcript: 'For a slow SQL query, inspect EXPLAIN before adding an index. Confirm the selected plan uses the intended index.' };
    vi.mocked(deps.material).mockResolvedValue({ ...skillMaterial, sources: [...skillMaterial.sources, source] });
    vi.mocked(deps.extract).mockResolvedValueOnce(extractedSkillFacts).mockResolvedValueOnce({ facts: [{ kind: 'procedure', claim: 'Inspect EXPLAIN before adding an index and confirm its use.', appliesWhen: 'Diagnosing a slow SQL query.', evidence: [{ cueId: 'v8-c0-p0', quote: source.transcript }] }] });
    const ids = extractedSkillFacts.facts.map((_, i) => `chunk-0-fact-${i}`);
    vi.mocked(deps.plan).mockResolvedValue({ skills: [{ objective: 'Implement the lab API client', factIds: ids }, { objective: 'Diagnose a slow SQL query', factIds: ['chunk-1-fact-0'] }] });
    const refs = ['chunk-1-fact-0'];
    const sqlDraft = { ...generatedSkillDraft, slug: 'sql-plan-diagnosis', title: 'Diagnose SQL plans', description: 'Inspect EXPLAIN before adding an index when diagnosing a slow SQL query.',
      criteria: [{ decision: 'Inspect the plan before adding an index.', factIds: refs }],
      steps: [{ action: 'Inspect EXPLAIN.', expectedResult: 'The chosen plan is visible.', factIds: refs }],
      exceptions: [], checks: [{ check: 'Confirm the plan uses the intended index.', factIds: refs }] };
    vi.mocked(deps.synthesize).mockResolvedValueOnce(generatedSkillDraft).mockRejectedValueOnce(new Error('Interrupted')).mockResolvedValueOnce(sqlDraft);
    vi.mocked(deps.audit).mockImplementation((_owner, _objective, draft) => Promise.resolve({ routingAppropriate: true, checks: draftClaims(draft).map(claim => ({ claimId: claim.id, grounded: true, actionable: true, reason: 'Supported by the source.' })) }));
    let view = await service.start('owner', { kind: 'course', resourceId: 42, language: 'en' });
    expect(view.automatic).toBe(true); expect(view.objective).toBe('');
    view = await service.advance('owner', view.id); expect(view.stage).toBe('extracting');
    view = await service.advance('owner', view.id); expect(view.stage).toBe('planning');
    view = await service.advance('owner', view.id); expect(view.members).toHaveLength(2);
    view = await service.advance('owner', view.id); expect(view.stage).toBe('auditing');
    view = await service.advance('owner', view.id); expect(view.members?.map(member => member.status)).toEqual(['passed', 'pending']);
    await expect(service.bundle('owner', view.id)).rejects.toThrow(/publish/);
    await expect(service.advance('owner', view.id)).rejects.toThrow('Interrupted');
    expect((await service.get('owner', view.id)).members?.[0].status).toBe('passed');
    view = await service.advance('owner', view.id); view = await service.advance('owner', view.id);
    expect(view.stage).toBe('published'); expect(view.members?.every(member => member.status === 'passed')).toBe(true);
    const bundle = await service.bundle('owner', view.id); expect(bundle.skills).toHaveLength(2);
    expect(new Set(bundle.skills?.map(item => item.name)).size).toBe(2);
    expect(bundle.skills?.[0].files['references/sources.md']).toContain('/videos/7?t=10');
    expect(bundle.skills?.[1].files['references/sources.md']).toContain('/videos/8');
    expect(bundle.skills?.[1].files['references/sources.md']).not.toContain('/videos/7');
    expect(deps.extract).toHaveBeenCalledWith('owner', '', 'en', expect.any(Array), undefined);
    expect(deps.plan).toHaveBeenCalledOnce();
    expect(vi.mocked(deps.audit).mock.calls[1][5]).toHaveLength(5);
  });
  it('automatically repairs an audit failure without repeating extraction or asking for approval', async () => {
    const { service, deps } = setup();
    const failed = { routingAppropriate: false, checks: draftClaims(generatedSkillDraft).map(claim => ({ claimId: claim.id, grounded: false, actionable: true, reason: 'Keep the source condition narrow.' })) };
    vi.mocked(deps.audit).mockResolvedValueOnce(failed);
    let view = await service.start('owner', { kind: 'course', resourceId: 42, language: 'en' });
    for (let i = 0; i < 4; i++) view = await service.advance('owner', view.id);
    expect(view.stage).toBe('synthesizing'); expect(view.members?.[0].status).toBe('pending');
    await expect(service.bundle('owner', view.id)).rejects.toThrow(/publish/);
    view = await service.advance('owner', view.id); view = await service.advance('owner', view.id);
    expect(view.stage).toBe('published'); expect(deps.extract).toHaveBeenCalledOnce(); expect(deps.plan).toHaveBeenCalledOnce();
    expect(deps.synthesize).toHaveBeenCalledTimes(2);
    expect(vi.mocked(deps.synthesize).mock.calls[1][5]).toMatchObject({ draft: generatedSkillDraft, issues: expect.arrayContaining([expect.stringContaining('Keep the source condition narrow.')]) });
  });
  it('keeps automatic generations unavailable if a member fails its audit', async () => {
    const { service, deps } = setup();
    vi.mocked(deps.audit).mockResolvedValue({ routingAppropriate: false, checks: draftClaims(generatedSkillDraft).map(claim => ({ claimId: claim.id, grounded: false, actionable: true, reason: 'Unsupported.' })) });
    let view = await service.start('owner', { kind: 'course', resourceId: 42, language: 'en' });
    for (let i = 0; i < 8; i++) view = await service.advance('owner', view.id);
    expect(view.stage).toBe('rejected'); expect(view.members?.[0].status).toBe('rejected');
    await expect(service.bundle('owner', view.id)).rejects.toThrow(/publish/);
    await expect(service.publish('owner', view.id)).rejects.toThrow(/checked draft/);
  });
  it('rejects topic plans that discard knowledge or invent fact identifiers', () => {
    const facts = checkedFacts(extractedSkillFacts, skillChunks(skillMaterial)[0], 0);
    expect(() => checkedPlan({ skills: [{ objective: 'Implement the client', factIds: [facts[0].id] }] }, facts)).toThrow(/omitted/);
    expect(() => checkedPlan({ skills: [{ objective: 'Implement the client', factIds: [...facts.map(f => f.id), 'invented'] }] }, facts)).toThrow(/unknown/);
  });
  it('preserves comparison operators in generated instructions after validation', async () => {
    const { service, start, deps } = setup(); const started = await start();
    const draft = structuredClone(generatedSkillDraft); draft.criteria[0].decision = 'Keep activeRequests <= 2 for this lab client.';
    vi.mocked(deps.synthesize).mockResolvedValue(draft);
    await service.advance('owner', started.id); await service.advance('owner', started.id);
    const checked = await service.advance('owner', started.id);
    expect(checked.markdown).toContain('activeRequests <= 2');
  });
  it('never exports a rejected draft or allows bypassing the quality check', async () => {
    const { service, start, deps } = setup(); const started = await start();
    vi.mocked(deps.audit).mockResolvedValue({ routingAppropriate: false, checks: draftClaims(generatedSkillDraft).map(claim => ({ claimId: claim.id, grounded: false, actionable: true, reason: 'Unsupported claim.' })) });
    await service.advance('owner', started.id); await service.advance('owner', started.id);
    expect((await service.advance('owner', started.id)).stage).toBe('rejected');
    await expect(service.publish('owner', started.id)).rejects.toThrow(/checked draft/);
    await expect(service.bundle('owner', started.id)).rejects.toThrow(/publish/);
  });
  it('preserves saved progress and releases its lease after a failed model call', async () => {
    const { service, start, deps, leases } = setup(); const started = await start();
    vi.mocked(deps.extract).mockRejectedValueOnce(new Error('Provider interrupted'));
    await expect(service.advance('owner', started.id)).rejects.toThrow('Provider interrupted');
    expect((await service.get('owner', started.id)).completedChunks).toBe(0); expect(leases.size).toBe(0);
    expect((await service.advance('owner', started.id)).completedChunks).toBe(1);
  });
  it('rejects concurrent steps and blocks source changes and other owners', async () => {
    const { service, start, deps, changeSource } = setup(); const started = await start();
    let finish!: () => void;
    vi.mocked(deps.extract).mockImplementationOnce(() => new Promise(resolve => { finish = () => resolve(extractedSkillFacts); }));
    const first = service.advance('owner', started.id); await vi.waitFor(() => expect(finish).toBeDefined());
    await expect(service.advance('owner', started.id)).rejects.toThrow(/another step/); finish(); await first;
    await expect(service.get('someone-else', started.id)).rejects.toThrow(/not found/);
    changeSource(); await expect(service.get('owner', started.id)).rejects.toThrow(/changed/);
    await expect(service.publish('owner', started.id)).rejects.toThrow(/changed/);
    await expect(service.bundle('owner', started.id)).rejects.toThrow(/changed/);
  });
  it('does not skip text in long cues and preserves real timestamps', () => {
    const chunks = skillChunks({ title: 'Long', sources: [{ id: 1, title: 'Long', transcript: `1\n00:00:01,000 --> 00:01:00,000\n${'長'.repeat(30_000)}` }] });
    expect(chunks).toHaveLength(3);
    expect(chunks.flat().map(cue => cue.text).join('')).toBe('長'.repeat(30_000));
    expect(chunks.flat().every(cue => cue.start === '00:00:01,000')).toBe(true);
    expect(skillChunks({ title: 'Plain', sources: [{ id: 1, title: 'Plain', transcript: 'A plain text source.' }] })[0][0].start).toBeNull();
  });
  it('rejects invented quotes, unknown facts, dropped exceptions, and incomplete audit coverage', () => {
    const cues = skillChunks(skillMaterial)[0]; const facts = checkedFacts(extractedSkillFacts, cues, 0);
    const invented = structuredClone(extractedSkillFacts); invented.facts[0].evidence[0].quote = 'Allow 100 concurrent requests.';
    expect(() => checkedFacts(invented, cues, 0)).toThrow(/match the source/);
    const unknown = structuredClone(generatedSkillDraft); unknown.steps[0].factIds = ['invented'];
    expect(() => checkedDraft(unknown, facts)).toThrow(/unknown fact/);
    expect(() => checkedDraft({ ...generatedSkillDraft, exceptions: [] }, facts)).toThrow(/exceptions/);
    expect(() => auditIssues({ routingAppropriate: true, checks: [{ claimId: 'step-0', grounded: true, actionable: true, reason: 'OK' }] }, generatedSkillDraft)).toThrow(/every skill claim/);
  });
});
