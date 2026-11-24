# Settings API-key ownership and feedback measurement

Measured on 2026-11-24, local macOS, installed workspace dependencies. Baseline
`758ea126`; change extracts `IntegrationApiKeysSection` from `SettingsPage`.
This is one small responsibility move, with no changed API, copy, DOM structure,
query keys, secret retention, clipboard behavior or cache race decisions.

## Why this boundary

Settings held integration key creation, one-time secret/copy feedback, list cache
updates, revocation confirmation and their async races alongside search credentials
and billing. The integration feature's state, effects, query/mutations and three
dialogs now live together, behind a prop-free component. Settings composes it
under the same integration heading, alongside ConnectedAppsSection. No secret or
callback bundle crosses the new boundary. The existing 33 page tests protect the
consumer-visible behavior, including stale refetch races, config identity during
revocation, one-time secret exclusion from cache and clipboard failure recovery.
The existing 11 page stories still exercise the real extracted component.

Recent Settings history includes TranscriptAPI integration, architecture cleanup,
loading controls, design-system changes, connected apps and LTI additions. This
is evidence of multiple change responsibilities, not evidence of a human-time
saving. AdminPage and persistence factory remain unchanged: no observed wiring
failure or concurrent-edit cost justifies expanding this refactor.

## Measurements and limits

| Indicator | Before | After / current observation |
|---|---|---|
| First local Settings test result, including npm startup | 4.36s wall; Vitest 2.28s | 3.17s wall; Vitest 1.84s; all 33 pass |
| Human change-understanding time | Not instrumented in existing history | Unknown; moving all integration logic together reduces unrelated scope, but does not prove faster comprehension |
| PR rework | No reliable historical attribution to this section | Await review; do not count unreviewed code as zero future rework |
| CI run queued-to-start | Run 45411887632 created and started 14:14:32Z | 0s at workflow level; frontend jobs start 14:15:09Z (37s after run creation) |
| CI Frontend Lint & Type Check | 14:15:09–14:16:16Z | 67s including setup, on baseline SHA 4e5f4d77 |
| CI Frontend Tests | 14:15:09–14:17:18Z | 129s including setup, same run |
| CI Frontend Storybook | 14:15:09–14:18:20Z | 191s including setup, same run |

Source: [CI run](https://github.com/videoq-jp/videoq/actions/runs/45411887632),
GitHub Actions jobs API timestamps; these durations do not isolate runner queue,
installation, or test execution. The local before/after are single sequential warm
runs, with no statistical speed claim. A structural extraction is not expected
to shorten CI. Reproduction:

```sh
/usr/bin/time -p npm test --workspace @videoq/web -- src/pages/__tests__/SettingsPage.test.tsx
npm run test:storybook -- src/pages/SettingsPage.stories.tsx
npm run typecheck --workspace @videoq/web
npm exec --workspace @videoq/web -- eslint src/pages/SettingsPage.tsx src/components/auth/IntegrationApiKeysSection.tsx
```

Post-change Storybook: 11 pass, 5.73s Vitest duration; typecheck and changed-file
lint pass. Existing Default/Mobile/EnglishMobile and GeneratedKeyCopyRetry /
GeneratedKeyCopyRetryEnglishMobile cover unchanged display and interactions; no
new state is introduced that needs a duplicate story or implementation-mirroring
test. Browser inspection is recorded in the PR validation.

## Answer-back window

For the next three integration-key changes or two weeks after merge, record in
PR notes: minutes from starting investigation to identifying the owning mutation
and regression test; elapsed first test result; review requests that require code
rework and their cause; Actions creation/start and job timings. Developers using
this section benefit; review and operations use the same commands and CI checks.
Compare changes of similar scope, and revisit this boundary if callers need many
props or cross-section state. Historical human timings cannot be reconstructed.

Cost is one component extraction and the existing focused verification, with no
new runtime dependency, DI framework, generated layer or team-wide training.
Reading the ownership comment and the existing race tests is the onboarding
exercise. No delivery date or learning-time allocation is changed. Broad page
splitting, DI-container introduction, CI reconstruction, and speculative install
caching are deferred until measured costs justify them.
