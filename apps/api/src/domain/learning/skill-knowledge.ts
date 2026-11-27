import { iterSrtCues } from '@videoq/domain/transcript';

export type SkillCue = { id: string; startMs: number; endMs: number; text: string };
export type SkillKnowledge = {
  kind: 'principle' | 'criterion' | 'procedure' | 'exception' | 'verification' | 'example';
  claim: string; appliesWhen: string[]; exceptions: string[];
  evidence: { cueId: string; quote: string }[];
  requiresVisualEvidence: boolean;
  visualEvidence?: { frameId: string; observation: string }[];
  versionContext: { language: string | null; framework: string | null; version: string | null };
};
export type SkillKnowledgeChunk = {
  version: 1; videoId: number; analysisRevision: string; chunkIndex: number;
  cues: SkillCue[]; facts: (SkillKnowledge & { id: string; status: 'supported' | 'needs_visual_review' })[];
  model: string; promptVersion: string;
  frames?: { id: string; timestampMs: number }[];
};
/** Invalidates visual interpretations made before per-claim time checks. */
export const SKILL_VISUAL_EVIDENCE_POLICY_VERSION = 'cue-window-v1';

/** Accept only claims with exact evidence in the server-selected subtitle window. */
export function verifySkillKnowledge(facts: SkillKnowledge[], cues: readonly SkillCue[], frames: readonly { id: string; timestampMs: number }[] = []): void {
  const byId = new Map(cues.map(c => [c.id, c]));
  if (facts.length > 40) throw new Error('SKILL_TOO_MANY_FACTS');
  const byFrameId = new Map(frames.map(f => [f.id, f]));
  for (const fact of facts) {
    if (!fact.claim.trim() || fact.evidence.length === 0) throw new Error('SKILL_UNSUPPORTED_FACT');
    for (const evidence of fact.evidence) {
      const cue = byId.get(evidence.cueId);
      if (!cue || !evidence.quote.trim() || !cue.text.includes(evidence.quote)) throw new Error('SKILL_INVALID_EVIDENCE');
    }
    for (const evidence of fact.visualEvidence ?? []) {
      const frame = byFrameId.get(evidence.frameId);
      // Match the reader's two-second margin, but apply it to this fact's
      // cited cues rather than the entire chunk or gaps between those cues.
      if (!frame || !evidence.observation.trim() || !fact.evidence.some(e => {
        const cue = byId.get(e.cueId)!;
        return frame.timestampMs >= cue.startMs - 2000 && frame.timestampMs <= cue.endMs + 2000;
      })) throw new Error('SKILL_INVALID_VISUAL_EVIDENCE');
    }
  }
}

/** Incremental raw SRT pages; incomplete cues carry over to the next page. */
export async function* skillTranscriptChunks(
  read: (offset: number) => Promise<{ text: string; nextOffset: number; done: boolean }>,
  maxCharacters = 12_000,
): AsyncGenerator<{ index: number; cues: SkillCue[] }> {
  let offset = 0, carry = '', cueNumber = 0, index = 0, size = 0;
  let cues: SkillCue[] = [];
  let pendingCR = false;
  while (true) {
    const page = await read(offset);
    if (!page.done && page.nextOffset <= offset) throw new Error('SKILL_SOURCE_NOT_PROGRESSING');
    offset = page.nextOffset;
    let raw: string = (pendingCR ? '\r' : '') + page.text;
    pendingCR = !page.done && raw.endsWith('\r');
    if (pendingCR) raw = raw.slice(0, -1);
    carry += raw.replace(/\r\n?/g, '\n');
    const boundaries = [...carry.matchAll(/\n[ \t]*\n/g)];
    const last = boundaries.at(-1);
    const end = page.done ? carry.length : last ? last.index + last[0].length : 0;
    const complete = carry.slice(0, end);
    carry = carry.slice(end);
    if (carry.length > maxCharacters * 2) throw new Error('SKILL_SUBTITLE_CUE_TOO_LARGE');
    for (const cue of iterSrtCues(complete)) {
      if (!cue) throw new Error('SKILL_INVALID_SUBTITLES');
      if (cue.text.length > maxCharacters) throw new Error('SKILL_SUBTITLE_CUE_TOO_LARGE');
      if (cues.length && size + cue.text.length > maxCharacters) { yield { index: index++, cues }; cues = []; size = 0; }
      cues.push({ id: `cue-${cueNumber++}`, startMs: Math.round(cue.startSeconds * 1000), endMs: Math.round(cue.endSeconds * 1000), text: cue.text });
      size += cue.text.length;
    }
    if (page.done) break;
  }
  if (cues.length) yield { index, cues };
}
