import {createHash} from 'node:crypto';
import {performance} from 'node:perf_hooks';
import type {SceneHit, SceneSearchRepository} from '../../../src/persistence/contracts/scene-search';

export type SearchEvaluationInput = {
 version: 1;
 cohort: 'synthetic' | 'production-rehearsal';
 /** Hash of the frozen corpus/archive, not a database name or credentials. */
 corpusSha256: string;
 model: string;
 dimensions: 768 | 1536;
 samples: number;
 cases: Array<{queryEmbedding: number[]; userId: string; videoIds: number[]; limit: number}>;
};

export class SearchEvaluationError extends Error {readonly name = 'SearchEvaluationError';}
const fail = (message: string): never => {throw new SearchEvaluationError(message);};
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

export function validateSearchEvaluationInput(raw: unknown): SearchEvaluationInput {
 if (!raw || typeof raw !== 'object') return fail('Invalid evaluation input.');
 const input = structuredClone(raw) as SearchEvaluationInput;
 if (input.version !== 1 || !['synthetic','production-rehearsal'].includes(input.cohort) ||
     !/^[a-f0-9]{64}$/.test(input.corpusSha256) || typeof input.model !== 'string' || !input.model.trim() || input.model.length > 256 ||
     ![768,1536].includes(input.dimensions) || !Number.isInteger(input.samples) || input.samples < 1 || input.samples > 30 ||
     !Array.isArray(input.cases) || !input.cases.length || input.cases.length > 1000) return fail('Invalid evaluation configuration.');
 for (const request of input.cases) {
  if (!request || typeof request.userId !== 'string' || !request.userId || request.userId.length > 256 ||
      !Array.isArray(request.videoIds) || !request.videoIds.length || request.videoIds.length > 10000 ||
      request.videoIds.some(id => !Number.isSafeInteger(id) || id <= 0) ||
      !Number.isInteger(request.limit) || request.limit < 1 || request.limit > 50 ||
      !Array.isArray(request.queryEmbedding) || request.queryEmbedding.length !== input.dimensions ||
      !request.queryEmbedding.every(value => typeof value === 'number' && Number.isFinite(value) && Number.isFinite(Math.fround(value))) ||
      !request.queryEmbedding.some(value => Math.fround(value) !== 0)) return fail('Invalid evaluation request.');
  request.videoIds = [...new Set(request.videoIds)];
 }
 return input;
}

function identities(hits: SceneHit[], request: SearchEvaluationInput['cases'][number]): string[] {
 if (!Array.isArray(hits) || hits.length > request.limit) return fail('Search result exceeds its contract.');
 const allowed = new Set(request.videoIds);
 return hits.map(hit => {
  if (!hit || !allowed.has(hit.videoId) || typeof hit.content !== 'string' || typeof hit.videoTitle !== 'string' ||
      typeof hit.startTime !== 'string' || typeof hit.endTime !== 'string' ||
      hit.evidenceType !== undefined && !['transcript','visual'].includes(hit.evidenceType)) return fail('Search result violates its scope or value contract.');
  // Metadata titles may legitimately differ from the current authoritative title.
  return digest([hit.videoId,hit.startTime,hit.endTime,hit.evidenceType ?? 'transcript',hit.content]);
 });
}
function intersection(left: string[], right: string[]) {
 const counts = new Map<string,number>();
 for (const item of left) counts.set(item,(counts.get(item) ?? 0)+1);
 let overlap = 0;
 for (const item of right) if ((counts.get(item) ?? 0) > 0) {overlap++; counts.set(item,counts.get(item)!-1);}
 return overlap;
}
function latency(values: number[]) {
 const sorted = [...values].sort((a,b) => a-b);
 const percentile = (p: number) => sorted[Math.ceil(sorted.length*p)-1];
 return {samples: sorted.length,p50_ms: percentile(.5),p95_ms: percentile(.95),p99_ms: percentile(.99)};
}

/** Run the SAME precomputed embeddings/scopes against actual repository handles.
 * No embeddings are regenerated; handles are owned/closed by the caller. Calls
 * are sequential and alternate backend order to limit systematic warmup bias.
 * This computes agreement with PG, NOT relevance recall against human labels.
 */
export async function evaluatePairedSceneSearch(
 repositories: {postgres: SceneSearchRepository; d1: SceneSearchRepository},
 raw: unknown,
 signal?: AbortSignal,
) {
 const input = validateSearchEvaluationInput(raw);
 const durations = {postgres: [] as number[],d1: [] as number[]};
 let pairs = 0, referenceNonempty = 0, referenceEmpty = 0, bothEmpty = 0,
     candidateEmpty = 0, candidateWhenReferenceEmpty = 0, overlapSum = 0, exactOrderPairs = 0,
     referenceHits = 0, candidateHits = 0, overlappingHits = 0;
 for (const request of input.cases) for (let sample = 0; sample < input.samples; sample++) {
  const results = {postgres: [] as string[],d1: [] as string[]};
  const order = pairs % 2 ? ['d1','postgres'] as const : ['postgres','d1'] as const;
  for (const backend of order) {
   signal?.throwIfAborted();
   const started = performance.now();
   const hits = await repositories[backend].search(structuredClone(request));
   const elapsed = performance.now()-started;
   signal?.throwIfAborted();
   durations[backend].push(elapsed);
   results[backend] = identities(hits,request);
  }
  const {postgres: reference,d1: candidate} = results, overlap = intersection(reference,candidate);
  pairs++; referenceHits += reference.length; candidateHits += candidate.length; overlappingHits += overlap;
  if (reference.length) {referenceNonempty++; overlapSum += overlap/reference.length;}
  else {referenceEmpty++; if (!candidate.length) bothEmpty++; else candidateWhenReferenceEmpty++;}
  if (!candidate.length) candidateEmpty++;
  if (JSON.stringify(reference) === JSON.stringify(candidate)) exactOrderPairs++;
 }
 return {
  version: 1, cohort: input.cohort, corpus_sha256: input.corpusSha256,
  request_set_sha256: digest(input.cases), model: input.model, dimensions: input.dimensions,
  cases: input.cases.length, samples_per_case: input.samples, paired_searches: pairs,
  agreement: {reference_nonempty_pairs: referenceNonempty, reference_empty_pairs: referenceEmpty,
   both_empty_pairs: bothEmpty,candidate_empty_pairs: candidateEmpty,
   candidate_nonempty_when_reference_empty: candidateWhenReferenceEmpty,
   mean_reference_top_k_overlap: referenceNonempty ? overlapSum/referenceNonempty : null,
   exact_rank_order_pairs: exactOrderPairs, reference_hits: referenceHits,candidate_hits: candidateHits,overlapping_hits: overlappingHits},
  latency: {measurement: 'repository-call-only',postgres: latency(durations.postgres),d1: latency(durations.d1)},
  acceptance_criteria_applied: false, execution_complete: false,
  limitations: [
   'Agreement with PostgreSQL is not human-labelled relevance recall; empty references do not count as perfect overlap.',
   'Repeated samples are not independent queries; a representative query set and approved thresholds are required.',
   'Corpus/model provenance is supplied by the caller and must be verified against source snapshots and target delivery receipts.',
   'Scene identity uses video, timestamps, evidence type and exact content; indistinguishable duplicate scenes are compared as multisets. Titles are excluded.',
   'Repository timings exclude connection setup, embedding generation and API/LLM execution; they are not E2E or controlled cold-start measurements.',
   'Selected video membership is checked here; ownership, account visibility and adversarial access control require separate repository/E2E tests.',
   'This report applies no quality, latency, capacity, cost or production cutover acceptance gate.',
  ],
 };
}
