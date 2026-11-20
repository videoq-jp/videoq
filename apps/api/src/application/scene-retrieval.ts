export const DEFAULT_SCENE_SEARCH_RESULTS = 20;
export const MAX_SCENE_SEARCH_RESULTS = 50;

export function validateSceneSearchLimit(limit: number): void {
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_SCENE_SEARCH_RESULTS) throw new Error('Search limit must be between 1 and 50');
}

/** Undefined selects the whole established scope. An explicitly empty or foreign
 * selection is an error, before the caller pays for a query embedding. */
export function sceneSearchSelection(allowed: ReadonlySet<number>, requested?: readonly number[]): number[] {
  if (requested !== undefined && (!requested.length || requested.some(id => !allowed.has(id)))) {
    throw new Error('Video selection must be a non-empty subset of the current course.');
  }
  return requested === undefined ? [...allowed] : [...new Set(requested)];
}

export type SceneCandidate = { score: number; revision: string; sceneId: string; vectorId?: string };
/** Retain only the best result for each physical/legacy identity while pages
 * arrive, so duplicate provider hits do not grow the per-request candidate set. */
export class SceneCandidateRanking {
  private readonly candidates = new Map<string, SceneCandidate>();
  add(candidate: SceneCandidate): void {
    const key = candidate.vectorId ?? `legacy:${candidate.sceneId}:${candidate.revision}`;
    const current = this.candidates.get(key);
    if (!current || candidate.score > current.score) this.candidates.set(key, candidate);
  }
  ranked(): SceneCandidate[] {
    return [...this.candidates].sort((a, b) => b[1].score - a[1].score || a[0].localeCompare(b[0])).map(([, candidate]) => candidate);
  }
}

export function sceneCandidateCurrent(row: { id: string; revision: string; vectorId: string | null; videoId: number } | undefined,
  candidate: SceneCandidate, allowedVideos: ReadonlySet<number>): boolean {
  if (!row || row.revision !== candidate.revision || !allowedVideos.has(row.videoId)) return false;
  return row.vectorId !== null ? row.vectorId === candidate.vectorId
    : candidate.vectorId === undefined || candidate.vectorId === row.id;
}

export interface SceneVisibilityLogic<Time, Predicate> {
  and(left: Predicate, right: Predicate): Predicate;
  or(left: Predicate, right: Predicate): Predicate;
  before(expires: Time, now: Time): Predicate;
}
/** Search hydration uses strict ban expiry and deactivation checks. Legacy
 * is_active is not part of this contract; keep SQL unknown values intact. */
export function sceneOwnerVisible<Time, Predicate>(facts: {
  mediaAllowed: Predicate; notDeactivated: Predicate; notBanned: Predicate; expires: Time; now: Time;
}, logic: SceneVisibilityLogic<Time, Predicate>): Predicate {
  return logic.and(logic.and(facts.mediaAllowed, facts.notDeactivated),
    logic.or(facts.notBanned, logic.before(facts.expires, facts.now)));
}
