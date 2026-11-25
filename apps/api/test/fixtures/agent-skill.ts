import type { SkillDraft, ExtractedFacts } from '@videoq/trpc/skills';
export const skillFixtureId = '3dc4072c-d22f-42f6-81e5-96f6686916ab';
export const skillMaterial = { title: 'Rate-limited API client lab', sources: [{ id: 7, title: 'Client retry policy', transcript: `1
00:00:10,000 --> 00:00:30,000
In this lab allow at most two requests in flight. A 429 response is deferred using Retry-After: return a deferred result and let the caller schedule it. Never sleep or retry in the helper.

2
00:00:30,000 --> 00:00:50,000
A 401 response is a permanent authentication failure. Do not retry it. For POST requests without an idempotency key, do not automatically retry even after a temporary failure.

3
00:00:50,000 --> 00:01:10,000
Test the policy with a fake clock and a recorded sequence of responses. Check the active request count never exceeds two and that a 429 produces exactly one request before returning deferred.
` }] };
export const extractedSkillFacts: ExtractedFacts = { facts: [
  { kind: 'principle', claim: 'The lab client permits at most two in-flight requests.', appliesWhen: 'Implementing the lab API client.', evidence: [{ cueId: 'v7-c0-p0', quote: 'In this lab allow at most two requests in flight.' }] },
  { kind: 'procedure', claim: 'On 429 return deferred with Retry-After; let the caller schedule, without sleep or retry in the helper.', appliesWhen: 'Handling a rate-limited response in the lab helper.', evidence: [{ cueId: 'v7-c0-p0', quote: 'A 429 response is deferred using Retry-After: return a deferred result and let the caller schedule it. Never sleep or retry in the helper.' }] },
  { kind: 'exception', claim: 'Do not retry 401, or POST without an idempotency key.', appliesWhen: 'Deciding whether a failed request can be retried.', evidence: [{ cueId: 'v7-c1-p0', quote: 'A 401 response is a permanent authentication failure. Do not retry it. For POST requests without an idempotency key, do not automatically retry even after a temporary failure.' }] },
  { kind: 'verification', claim: 'Use a fake clock and response sequence to verify max concurrency two and a single request before deferring 429.', appliesWhen: 'Testing the lab policy.', evidence: [{ cueId: 'v7-c2-p0', quote: 'Test the policy with a fake clock and a recorded sequence of responses. Check the active request count never exceeds two and that a 429 produces exactly one request before returning deferred.' }] },
] };
const refs = (index: number) => [`chunk-0-fact-${index}`];
export const generatedSkillDraft: SkillDraft = {
  slug: 'rate-limited-client', title: 'Implement the lab API client policy',
  description: 'Implement or review the lab API client: two requests in flight, defer HTTP 429 with Retry-After, and avoid unsafe authentication or non-idempotent retries.',
  useWhen: ['Implementing or reviewing request scheduling and retry handling for the lab API client.'],
  doNotUseWhen: ['Do not apply the lab concurrency limit to unrelated APIs without checking their own limits.'],
  criteria: [{ decision: 'For this lab client, cap concurrent in-flight requests at two.', factIds: refs(0) }],
  steps: [{ action: 'On HTTP 429 return a deferred result using Retry-After so the caller can schedule it. Do not sleep or retry in the helper.', expectedResult: 'The helper returns after one rate-limited request.', factIds: refs(1) }],
  exceptions: [{ condition: 'HTTP 401, or POST lacking an idempotency key.', behavior: 'Do not automatically retry.', factIds: refs(2) }],
  checks: [{ check: 'Use a fake clock and recorded responses; verify active request count stays at most two and 429 results in a single request followed by deferred.', factIds: refs(3) }],
  examples: [],
};

export const multiSkillMaterial = { ...skillMaterial, title: 'API client and SQL performance course', sources: [...skillMaterial.sources,
  { id: 8, title: 'Diagnosing slow SQL', transcript: `1
00:00:10,000 --> 00:00:40,000
For a slow SQL query, first capture its execution plan with EXPLAIN before adding an index. Identify which scan consumes the time and compare the estimated row counts with observed counts. Add an index only when it supports the query's filter or join, then compare the plan again. Do not assume that every sequential scan is a problem: a small table may be cheaper to scan. Verify that the chosen index is actually used and that the measured query latency improves on the same representative workload.
` },
] };
