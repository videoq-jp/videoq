# Cloudflare resources for VideoQ

## Current production resources

VideoQ uses the existing Cloudflare account
`12daec56fdba43f677f2766ee26a5a39` and its existing shared billing.
Filter **Manage Account → Resource Tagging** by `project=videoq` to find the
production resources. Tags classify resources; they do not provide a separate
billing or access-control boundary.

| Resource type | Production physical name | Component tag |
| --- | --- | --- |
| D1 | `videoq-prod-db` | `database` |
| Vectorize | `videoq-prod-scenes-1536` | `scene-search-1536` |
| Vectorize | `videoq-prod-scenes-768` | `scene-search-768` |
| Worker | `videoq-api` | `api` |
| Worker | `videoq-web` | `web` |
| Worker | `videoq-docs` | `docs` |
| R2 | `videoq-media-prod` | `media` |

The production D1 UUID is `587bd210-6d9d-4f32-abb7-a490013e65d3`.
The Vectorize suffixes identify embedding dimensions. Both configured dimensions
retain their bindings, cosine metric and ownership-filter metadata indexes.
Worker identities, R2 media, application secrets, account and DNS are preserved.
All seven resources use `project=videoq` and `environment=production`; replacement
candidate lifecycle tags have been removed after the verified handoff.

## Completed naming replacement

The verified production replacement used maintenance run `9f7487fac116c04596c61e5292d9629a`, pinned
to reviewed source `b7d6097b552544a9f1c966b619caf579a919235a`. API traffic, the three SQS consumers and
deployments were paused; the source was write-fenced before its final snapshot.
The complete D1 schema, typed values, SQLite sequences and vectors were compared
before binding promotion. Native upload, processing, search, cited-answer and SSE
checks passed after the target resumed. Admission was restored and the native
maintenance execution released its own lock.

The former production D1 `videoq-d1-migration-staging-v4` and the two
`videoq-scenes-migration-v3-*` indexes were retired after backup and verification.
Earlier unused rehearsal resources had already been removed. D1 migration-history
tables remain part of the production data and schema lifecycle.

Private SQL and vector recovery artifacts are stored in the existing encrypted,
versioned archive bucket. SQL exports and vector values must stay out of Git,
logs and public CI artifacts. The bounded SQL was restored and compared against
its sealed source snapshot before it was accepted as a recovery artifact.

[Aggregate naming-cutover evidence](evidence/cloudflare-production-names-2026-11-19.json)
contains resource names, run and source references, counts and proof hashes only.
The opt-in resource-hold capability is disabled after completion.

## Historical preparation and implementation notes

[Preparation history](cloudflare-resource-organization-history.md) preserves the
older resource names, candidate checks, rehearsals and coordinator development
milestones. Those dated records describe their execution context. Use the table
above and `apps/api/wrangler.jsonc` for current production resource names.

## References

- [Resource Tagging](https://developers.cloudflare.com/resource-tagging/)
- [Supported resource types](https://developers.cloudflare.com/resource-tagging/reference/resource-types/)
- [D1 import and export](https://developers.cloudflare.com/d1/best-practices/import-export-data/)
- [D1 state bookmarks](https://developers.cloudflare.com/api/resources/d1/subresources/database/subresources/time_travel/methods/get_bookmark/)
