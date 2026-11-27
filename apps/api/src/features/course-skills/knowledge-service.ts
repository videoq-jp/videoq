import { skillTranscriptChunks, verifySkillKnowledge, type SkillKnowledge, type SkillKnowledgeChunk } from '../../domain/learning/skill-knowledge';
import type { CourseSkillKnowledgeRepository, SkillBuildLease } from '../../persistence/contracts/course-skill-knowledge-repository';
import type { CourseSkillSource } from '../../persistence/contracts/course-skill-input-repository';

export interface SkillKnowledgeDependencies {
  repository: CourseSkillKnowledgeRepository;
  hash(value: string): Promise<string>;
  now(): number;
  model: string;
  promptVersion: string;
  chunkCharacters?: number;
  extract(cues: { id: string; startMs: number; endMs: number; text: string }[], language: 'ja' | 'en'): Promise<SkillKnowledge[]>;
  visuals?(cues: { id: string; startMs: number; endMs: number; text: string }[], facts: SkillKnowledge[]): Promise<{ id: string; timestampMs: number; jpegBase64: string }[]>;
  extractVisual?(cues: { id: string; startMs: number; endMs: number; text: string }[], facts: SkillKnowledge[], frames: { id: string; timestampMs: number; jpegBase64: string }[], language: 'ja' | 'en'): Promise<SkillKnowledge[]>;
  /** Quota reservation belongs here; called only for uncached model invocations. */
  beforeModel(): Promise<void>;
}

export async function extractSkillKnowledge(
  deps: SkillKnowledgeDependencies,
  input: { lease: SkillBuildLease; source: CourseSkillSource; language: 'ja' | 'en'; policyVersion: string; maxModelCalls: number },
) {
  if (!input.source.ready || !Number.isSafeInteger(input.maxModelCalls) || input.maxModelCalls < 1) throw new Error('INVALID_SKILL_EXTRACTION_INPUT');
  const keys: string[] = [];
  let calls = 0;
  const read = async (offset: number) => {
    const page = await deps.repository.readPage(input.lease, input.source.videoId, offset, deps.now());
    if (!page) throw new Error('SKILL_INPUT_CHANGED');
    return page;
  };
  for await (const chunk of skillTranscriptChunks(read, deps.chunkCharacters ?? 12_000)) {
    const key = await deps.hash(JSON.stringify({ ownerId: input.lease.ownerId, videoId: input.source.videoId, analysisRevision: input.source.analysisRevision,
      policyVersion: input.policyVersion, language: input.language, model: deps.model, promptVersion: deps.promptVersion, chunk }));
    let cached = await deps.repository.cached(input.lease, key, deps.now());
    if (!cached) {
      if (calls >= input.maxModelCalls) return { status: 'budget_exhausted' as const, keys, modelCalls: calls };
      await deps.beforeModel();
      calls++;
      const facts = await deps.extract(chunk.cues, input.language);
      verifySkillKnowledge(facts, chunk.cues);
      const result = { version: 1 as const, videoId: input.source.videoId, analysisRevision: input.source.analysisRevision, chunkIndex: chunk.index,
        cues: chunk.cues, facts: facts.map((fact, index) => ({ ...fact, id: `${key}:${index}`, status: fact.requiresVisualEvidence ? 'needs_visual_review' as const : 'supported' as const })),
        model: deps.model, promptVersion: deps.promptVersion };
      if (!await deps.repository.save(input.lease, key, result, deps.now())) throw new Error('SKILL_INPUT_CHANGED');
      cached = result;
    }
    let selectedKey = key;
    if (cached.facts.some(f => f.requiresVisualEvidence) && deps.visuals && deps.extractVisual) {
      const frames = await deps.visuals(chunk.cues, cached.facts);
      if (frames.length) {
        const visualKey = await deps.hash(JSON.stringify({ key, visualRevision: input.source.visualRevision, frames: frames.map(({ id, timestampMs }) => ({ id, timestampMs })) }));
        if (!await deps.repository.cached(input.lease, visualKey, deps.now())) {
          if (calls >= input.maxModelCalls) return { status: 'budget_exhausted' as const, keys, modelCalls: calls };
          await deps.beforeModel(); calls++;
          const facts = await deps.extractVisual(chunk.cues, cached.facts, frames, input.language);
          verifySkillKnowledge(facts, chunk.cues, frames);
          const result: SkillKnowledgeChunk = { ...cached, frames: frames.map(({ id, timestampMs }) => ({ id, timestampMs })), facts: facts.map((fact, index) => ({ ...fact, id: `${visualKey}:${index}`, status: fact.requiresVisualEvidence && !fact.visualEvidence?.length ? 'needs_visual_review' : 'supported' })) };
          if (!await deps.repository.save(input.lease, visualKey, result, deps.now())) throw new Error('SKILL_INPUT_CHANGED');
        }
        selectedKey = visualKey;
      }
    }
    keys.push(selectedKey);
  }
  return { status: 'completed' as const, keys, modelCalls: calls };
}
