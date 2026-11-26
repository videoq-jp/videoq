export type VisualRun = { videoId: number; runId: string; fileKey: string; durationMs: number; chunkCount: number; status: string; publicationVersion: string | null };
export type VisualChunk = { index: number; frameCount: number | null; objectVersion: string | null };

export function visualPlan(durationMs: number) {
  if (!Number.isSafeInteger(durationMs) || durationMs <= 0 || durationMs > 36_000_000) throw new Error('Invalid visual duration');
  return { count: Math.ceil(durationMs / 60_000) };
}

export function validVisualVersion(version: string): boolean {
  return /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(version);
}

export function validateVisualCheckpoint(frameCount: number, version: string): void {
  if (!Number.isSafeInteger(frameCount) || frameCount < 0 || frameCount > 60 || !validVisualVersion(version)) {
    throw new Error('Invalid visual checkpoint');
  }
}

export function visualObjectAttempt(version: string, index?: number) {
  if (!validVisualVersion(version) || (index !== undefined && (!Number.isSafeInteger(index) || index < 0 || index > 599))) {
    throw new Error('Invalid visual object attempt');
  }
  return { id: `${index === undefined ? 'm' : 'c'}:${version}`, kind: index === undefined ? 'manifest' : 'chunk' };
}

/** Evaluate facts or compose predicates under the persistence write fence. */
export interface VisualLogic<Predicate> {
  and(...terms: Predicate[]): Predicate;
  or(...terms: Predicate[]): Predicate;
  not(term: Predicate): Predicate;
}

export function visualSourceCurrent<P>(sameFile: P, uploaded: P, logic: VisualLogic<P>): P {
  return logic.and(sameFile, uploaded);
}

export function visualRunMutable<P>(current: P, notReady: P, logic: VisualLogic<P>): P {
  return logic.and(current, notReady);
}

export function visualAttemptAllowed<P>(mutable: P, hasIndex: P, chunkPending: P, logic: VisualLogic<P>): P {
  return logic.and(mutable, logic.or(logic.not(hasIndex), chunkPending));
}

export function visualChunkPublishAllowed<P>(chunkPending: P, liveAttempt: P, mutable: P, logic: VisualLogic<P>): P {
  return logic.and(chunkPending, liveAttempt, mutable);
}

export function visualRunRecoveryAllowed<P>(facts: { notReady: P; noChunkErrors: P; winningChunk: P; current: P }, logic: VisualLogic<P>): P {
  return logic.and(facts.notReady, facts.noChunkErrors, facts.winningChunk, facts.current);
}

export function visualAttemptAdoptable<P>(published: P, pending: P, live: P, logic: VisualLogic<P>): P {
  return logic.or(published, logic.and(pending, live));
}

export function visualReadyAllowed<P>(facts: { current: P; adoptableAttempt: P; complete: P; hasFrames: P }, logic: VisualLogic<P>): P {
  return logic.and(facts.current, facts.adoptableAttempt, facts.complete, facts.hasFrames);
}

export function visualObjectDesired<P>(facts: { current: P; manifest: P; ready: P; winningManifest: P; chunk: P; winningChunk: P }, logic: VisualLogic<P>): P {
  return logic.and(facts.current, logic.or(logic.and(facts.manifest, facts.ready, facts.winningManifest), logic.and(facts.chunk, facts.winningChunk)));
}
