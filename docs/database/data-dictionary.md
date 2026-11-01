---
title: Data dictionary
description: Find tables by purpose and follow links to the actual column definitions.
---

# Data dictionary

Use this list to find the table containing the data you need. For complete column types, defaults, and constraints, see [modern.ts](https://github.com/videoq-jp/videoq/blob/main/apps/api/src/db/schema/modern.ts) and [better-auth.ts](https://github.com/videoq-jp/videoq/blob/main/apps/api/src/db/schema/better-auth.ts).

## Users and authentication

| Table | Stores |
|---|---|
| `users` | Users, quotas, billing relationships, and encrypted external API keys |
| `session` | Better Auth login sessions and expiration |
| `account` | Password credentials and identity-provider connections such as Google |
| `verification` | Verification data for email confirmation, password resets, and related flows |
| `apikey` | MCP API keys and access scopes |
| `jwks` | Keys used to sign OAuth tokens |
| `account_deletion_requests` | Account deletion requests |
| `device_code` | Better Auth device authorization (RFC 8628) requests |

## Videos, courses, and tags

| Table | Stores |
|---|---|
| `videos` | Video title, owner, file reference, spoken language (`transcription_language`; null means automatic detection), transcript, and processing state |
| `video_courses` | Courses, owners, and sharing settings |
| `video_course_members` | **Videos** included in a course and their display order |
| `video_course_memberships` | Membership information for **people** using a course |
| `video_course_invitations` | Course invitations and their state |
| `tags` / `video_tags` | User tags / their associations with videos |
| `video_transcription_runs` / `video_transcription_chunks` | Each video's resumable transcription plan / saved segments, retries, and errors for each interval |
| `video_visual_runs` / `video_visual_chunks` | Each video's visual-cache build plan and status / state of each chunk |

## Questions, answers, and evaluations

| Table | Stores |
|---|---|
| `chat_logs` | Questions, structured answers in `response` JSONB (`segments` and `sources`), retrieved contexts, and user feedback |
| `chat_log_evaluations` | Historical evaluation results (retired; no new writes) |
| `course_evaluation_snapshots` | Historical evaluation aggregates (retired) |
| `ai_answer_attempts` | Anonymous per-answer cost ledger, without a user ID, prompt, response, or provider credential |

`chat_logs.response` is the canonical answer. The old separate `answer` and `citations` columns were removed. History returns this same structure; CSV exports derive plain text by concatenating segment texts. See [the answer contract](../architecture/prompt-engineering.md#structured-answers-citations-and-permissions) and [historical data conversion](../architecture/structured-answers.md).

## Search

| Table | Stores and caveats |
|---|---|
| `scene_embeddings` | Subtitle segments and search embeddings; currently 1536 dimensions |

## Delivery, duplicate protection, and billing

| Table | Stores |
|---|---|
| `external_tasks` | Work to dispatch externally and its delivery state |
| `job_executions` | Execution state of jobs received by the worker |
| `mcp_idempotency_records` | Records preventing duplicate effects from repeated MCP operations |
| `stripe_events` | Records preventing duplicate processing of received Stripe events |
| `runtime_rate_limits` | Shared rate-limit windows for the on-prem Node.js runtime; Cloudflare Workers use the `RATE_LIMITER` Durable Object |

## OAuth

| Table | Stores |
|---|---|
| `oauth_client` | Registered external clients |
| `oauth_resource` / `oauth_client_resource` | Target APIs and permitted client associations |
| `oauth_access_token` / `oauth_refresh_token` | Issued tokens and refresh information |
| `oauth_consent` | Scopes authorized by users for clients |
| `oauth_client_assertion` | Information preventing reuse of client authentication assertions |

## Common conventions

User IDs are UUIDs stored as text; videos, courses, and similar entities use numeric IDs. Timestamps are mostly stored with time zones and exposed by the API as UTC ISO-8601 values. Check each table's foreign keys and unique constraints for related-row deletion and duplicate prevention.

**Related:** [ER diagrams](er-diagram.md), [Change the database](../guides/database.md).
