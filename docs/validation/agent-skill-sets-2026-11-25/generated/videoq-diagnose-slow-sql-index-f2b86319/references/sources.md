# Source evidence

Material: API client and SQL performance course
Source fingerprint: 9924ec2afd917fc9cbb97b580e339a93dec4224bb0092cbde41eb0be0d429c81
Coverage: all subtitle chunks were processed; only facts relevant to the requested task are included below.

## chunk-1-fact-0

Claim: Capture the execution plan with EXPLAIN before adding an index. Identify the scan consuming time and compare estimated row counts with observed counts.
Applies when: Diagnosing a slow SQL query.

[Diagnosing slow SQL](https://videoq.example/videos/8?t=10) — 00:00:10,000 → 00:00:40,000

> For a slow SQL query, first capture its execution plan with EXPLAIN before adding an index. Identify which scan consumes the time and compare the estimated row counts with observed counts.

## chunk-1-fact-1

Claim: Add an index only when it supports the query’s filter or join, then compare the execution plan again.
Applies when: Considering an index for a slow query.

[Diagnosing slow SQL](https://videoq.example/videos/8?t=10) — 00:00:10,000 → 00:00:40,000

> Add an index only when it supports the query's filter or join, then compare the plan again.

## chunk-1-fact-2

Claim: A sequential scan is not necessarily a problem; scanning a small table may be cheaper.
Applies when: Evaluating a sequential scan in an execution plan.

[Diagnosing slow SQL](https://videoq.example/videos/8?t=10) — 00:00:10,000 → 00:00:40,000

> Do not assume that every sequential scan is a problem: a small table may be cheaper to scan.

## chunk-1-fact-3

Claim: Verify that the chosen index is used and that measured query latency improves on the same representative workload.
Applies when: Checking the effect of an index change.

[Diagnosing slow SQL](https://videoq.example/videos/8?t=10) — 00:00:10,000 → 00:00:40,000

> Verify that the chosen index is actually used and that the measured query latency improves on the same representative workload.
