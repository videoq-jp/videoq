# Course skill generation without fixed course-size caps

Removed the 30-video, 180,000-subtitle-character, 180-fact / 120,000-fact-character and 12-skill automatic-generation caps. The old manual-objective 80-fact / 24,000-character rejection is also removed: large objective-scoped generations use the same partitioned pipeline.

The runtime still bounds an individual model request (subtitle chunks, planning/context batches, structured outputs and request timeouts). All cursors are persisted. These are batch sizes, not total course limits. Existing owner authorization, source fingerprints, grounded audits, finite repair attempts, AI quota accounting, lease fencing and installation path/overwrite checks remain.

Course video IDs and owner-scoped transcripts are fetched in pages. Knowledge planning is incremental; skill identities include stable member keys so independently generated slugs cannot collide. Each skill's audit visits every saved course-fact batch before publication. Larger courses therefore require more model calls and time, and can pause/resume when the provider, user or AI allowance interrupts a step. Facts are never truncated to fit one global prompt.

Large state is stored as an atomic versioned snapshot across `agent_skill_state_parts`; small/legacy state stays inline. D1 values stay below 256 KB of UTF-8 per part. Pointer replacement and obsolete-revision deletion commit with part writes; readers retry if they race a retired revision. Account deletion cascades through the parent record. PostgreSQL uses the same snapshot layout in a transaction. New migrations: PostgreSQL 0068, D1 0021. Rolling back to old code cannot read new partitioned jobs; retain the new reader when rolling back other changes.

The CLI asks `get_skill` for one artifact at a time and follows validated offsets/totals, then installs the complete set atomically into both agents. The 2 MB SSE response bound remains per response and no longer caps the whole set. Legacy complete-set responses remain supported.

Validation:

- 177-video / 354,000-character material read without truncation, using two course pages and two transcript queries.
- Automatic generation processes 177 subtitle chunks and 354 facts (>120,000 characters), produces more than 12 schema-valid skills, audits every course fact for every skill, and exports paged complete artifacts with unique names.
- Native D1 persists >2 MB of Japanese/emoji state across parts, preserves exact text, fences stale leases, rolls back an injected failed part write, retires old revisions, and cascades account deletion.
- Real PostgreSQL 17 isolated-schema test verifies partitioned reads, transaction rollback on an injected part failure, stale-writer fencing and account cascade.
- Real npm 12 command downloads 17 paged authenticated skills through the bundled route and installs all 17 into both `.agents/skills` and `.claude/skills`, without changing package files.
- CLI regression suite checks >2 MB total paged evidence, pagination integrity, traversal/symlink/overwrite defenses, MCP authentication, SSE parsing and atomic conflict handling.

No real course generation/model quota was consumed by these synthetic tests. Production deployment evidence will be added after canonical CI and guarded schema maintenance.
