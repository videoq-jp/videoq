---
title: Responsibility and release contract
description: Logical ownership, shared persistence invariants, and staged consumer changes.
---

# Responsibility and release contract

This records the implemented boundaries inspected on 2026-11-24 and a release
contract for future changes. It does not create new services. API, Python media
processing, Node background processing and inference already run separately;
shared state and message contracts still constrain their releases. Read the
[business event model](bpmn.md) before mapping these roles to infrastructure.

Named teams and on-call assignments have not been supplied. The ownership roles
below describe the responsibility a release must assign, not confirmed staffing
or an agreement with business stakeholders. An additional independently operated
service needs an explicit person/team for each role before adoption.

## Logical ownership

| Responsibility | Current writers and authoritative state | Authorization decision | Synchronous invariant | Delayed work and its limit | Operational ownership role |
|---|---|---|---|---|---|
| Material ingestion | API upload repositories reserve/confirm material and delivery intent; Python media processing saves transcription through the configured PostgreSQL or signed internal API path; search consumer publishes current scenes | API authenticated owner / LMS upload scope; workers validate internal credentials and job identity, not browser authority | Reservation, allowance and material state must agree; confirmation matches owner, file and state; source/run/revision fencing rejects stale completion | Transcription, indexing and physical cleanup retry after durable intent. Search visibility follows readiness. No business-approved maximum delay is recorded; alert on aged pending work/DLQ and withhold ready status | Material ingestion maintainer owns stalled uploads and transcription; search maintainer owns publication/readiness; storage operator handles physical cleanup. Incident lead coordinates across them |
| Learning and access | API owns course membership, sharing and LMS bindings through repository contracts; external LMS provides its identity assertions | Current API access policy using session/API key/OAuth scope plus course/share/LMS scope; client and vector metadata are not the authority | Validate current permitted material scope; ownership/visibility/revision checks apply again when evidence is hydrated | External LMS updates and cleanup may arrive later. Permission revocation must not intentionally rely on an eventual search index. No numeric LMS propagation promise is established | Access maintainer owns permission incidents and LMS integration; security escalation owns suspected unauthorized disclosure |
| Question answering | API chat execution owns answer execution, chat logs and feedback; dedicated Durable Object handles cloud execution; retrieval reads published scene state | API derives access context before generation and history/feedback policies verify course ownership/share token as applicable | Reserve usage before generation, correlate execution and completion, retain authorized evidence scope; feedback cannot modify another course's record | Answer streaming, persistence recovery and evidence visibility can progress asynchronously. Do not expose a pending indexing operation as finished merely because a queue message was ACKed | Answer execution maintainer owns stuck runs, stream recovery and generation failures; retrieval maintainer assists with missing citations |
| Billing and allowances | API billing/webhook handling owns plan state; atomic repositories own usage reservation/refund decisions; account consumer executes durable deletion/cleanup requests | Verified account authority and provider webhook verification; entitlement decisions use persisted effective plan, not a client claim | Concurrent reservations cannot exceed allowance; refunds obey reservation period/state and cannot double-credit; duplicate provider events must not create repeated effects | Provider events, account deletion and physical release can retry. Unconfirmed upload refund differs from confirmed usage; storage release follows cleanup. Provider lag tolerance and escalation SLA remain a product/operations decision | Billing maintainer owns webhook reconciliation and quota disputes; account lifecycle maintainer owns deletion completion; finance/product decides policy changes |

Implementation entry points: [upload service](../../apps/api/src/features/videos/upload-service.ts),
[resource access](../../apps/api/src/application/resource-access.ts),
[native course access](../../apps/api/src/application/native-course-access.ts),
[scene retrieval](../../apps/api/src/application/scene-retrieval.ts),
[chat generation](../../apps/api/src/features/chat/generation-service.ts),
[billing](../../apps/api/src/features/billing/service.ts), and
[persistence assembly](../../apps/api/src/persistence/factory.ts).
These links identify writers/policies, not permission to write another logical
owner's tables directly. Preserve ports/adapters when moving a responsibility.

## Shared persistence and message compatibility

Cloud uses D1, R2, Vectorize and Cloudflare search/account queues; on-premises
uses PostgreSQL, S3-compatible storage and dedicated SQS-compatible queues with
Python media and Node search/account consumers. Cloud media processing uses the
signed internal API for shared mutations. Do not treat D1 and PostgreSQL as
simultaneous masters or assume PostgreSQL changes update the D1 schema.

The shared `job_executions` contract is implemented by
[TypeScript PostgreSQL](../../apps/api/src/persistence/postgres/job-repository.ts),
[TypeScript D1](../../apps/api/src/persistence/d1/job-repository.ts), and
[Python](../../apps/worker/worker_python/job_execution.py).
A job ID identifies one job type and canonical payload digest. Different type or
digest is a conflict; completed replay has no repeated business effect; active
leases cause retry. Claim ownership is a fresh lease token. Completion/failure
require that token and running state; heartbeat must still be unexpired. A
replacement consumer must not relax these fences or reset completed jobs.
Queue visibility and database leases are separate mechanisms: neither makes
external effects exactly once. Dispatch intent, business idempotency and stale
source checks still apply when ACK is lost or a process dies.

The [shared wire fixtures](../../packages/domain/test/fixtures/background-jobs.json)
exercise both TS and Python acceptance, canonical serialization/digest and replay.
The fixture README defines the tested wire scope. Keep valid old hashes stable;
never rewrite queued payloads under an existing job ID merely to change encoding.
New producers use the discriminated [JobMessage](../../apps/api/src/lib/jobs.ts)
contract, but the compatibility gate must test the deployed old consumer as well.
The required `delivery-regression` CI job pins independently deployed API and
Python consumer source revisions and runs their real producer/consumer entry
points against the candidate, including rejection, canonical hashes and completed
redelivery suppression. See [pins, provenance and rollout gating](../verification/delivery-regression.md).
An incompatible combination blocks the existing mixed deployment path; changing
the baseline to the candidate is not an incompatibility waiver.
A passing new/new test alone cannot authorize mixed-version rollout.

For database changes, expand before switching writers: add compatible fields or
indexes, migrate/backfill with counts and invariant checks, deploy readers that
accept old and new records, then deploy writers. Remove/rename fields or change
status meaning only after all readers, workers, recovery tasks and retained
messages no longer need the old contract. D1 and PostgreSQL migrations need their
own checks. The deep-history index migration in this PR drops/recreates an index;
on-prem maintenance must account for lock/build time. Independent processes do
not imply independently reversible schema releases.

## When another physical boundary is justified

Keep logical modules in the current deployment until evidence identifies a
specific constraint: independent resource scaling cannot meet the measured queue
age/latency target, release collisions repeatedly block one responsibility, or
fault isolation is needed for observed blast radius. Record the target, baseline,
cost of another queue/database/deployment/on-call path and success criterion.
Choose a boundary around a business operation, not around a table or technical
layer. Named ownership, traces, failure recovery and an agreed consistency/lag
contract are prerequisites. No such additional-service business case has been
established by this review, so no infrastructure split is proposed.

## Staged cutover example: scene indexing

The switch point is dispatch of a scene-index job for a specific material source
revision. This is a future migration procedure, not a migration performed here.

1. **Prepare:** assign old/new consumer and incident owners; record image/source
   SHAs, queue names, schema versions, pending job IDs and oldest age, DLQ backlog,
   current-source readiness, duplicate/conflict/error rates and rollback point.
   Freeze destructive migrations. Preserve one authoritative business writer.
2. **Expand and prove:** apply backward-compatible schema first; run old/new
   reader and consumer combinations on the shared fixtures and real DB/queue
   failure tests. Shadow computation may compare results but cannot publish
   vectors, alter usage or complete production jobs. An adapter translates an
   old external model; it must not silently change job identity/digest.
3. **Drain old work:** stop old producers, including scheduler/recovery dispatch,
   for the selected operation. Let the old consumer finish its queue. Count
   visible, delayed and in-flight messages, running DB leases and durable
   undispatched intents. Zero visible messages alone is insufficient. Wait for
   in-flight work to finish or its visibility/lease to expire and safely reclaim;
   resolve DLQ and old scheduled intents. Do not purge work to declare a drain.
4. **Switch one route:** explicitly route new jobs to the new consumer/queue;
   keep its handler for retained old payloads until retention/recovery windows
   have passed, or retain the old queue/consumer until all old work is resolved.
   Never let two handlers own business writes just because queues differ.
   A mixed rollout on one queue requires both versions to accept every message
   either can receive; otherwise use dedicated routing and a maintenance window.
5. **Observe and stop criteria:** compare counts/source revisions, readiness and
   answer evidence quality, queue age/DLQ, classified failures, lease conflicts,
   resource cost and latency against the predeclared target. Pause new dispatch
   on any stale-source publication, unauthorized evidence, lost/duplicate effect,
   unsupported old payload or an exceeded agreed error/age threshold. Do not
   invent a numeric SLO when product/operations have not approved one.
6. **Rollback:** stop new producers first and account for in-flight new work.
   If schema and messages remain compatible, route back, preserve job IDs and
   replay idempotently with the authoritative writer. If destructive schema or
   data changes occurred, reverting an image is insufficient: stop all affected
   writers and use the tested consistent restore procedure with explicit data
   loss window. Reconcile DB rows, objects, vectors, job intents and queues;
   restoring DB alone does not restore published search state. Follow
   [D1 readiness/restore scope](../operations/d1-production-readiness.md) or the
   on-prem backup/restore procedure rather than connecting a retired database.
7. **Retire:** remove the old consumer only after no active leases, delayed or
   in-flight messages, recovery intents or DLQ items require it, mixed-version
   retention windows have elapsed, comparison gates pass, and rollback evidence
   is accepted. Contract schema removal is a later release. Record which owner
   accepted the remaining operational burden before deleting old resources.

On-prem `videoq.py update` already groups API/background/scheduler/migration
images, stops writers for backup, and refuses automatic image rollback after a
migration failure. Keep that release unit while the DB contract is shared.
See [the lifecycle implementation](../../scripts/onprem/videoq.py).
