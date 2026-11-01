# Storybook contribution and review workflow

When changing a UI state or interaction, update the affected component's stories in the same PR. See the [Frontend README](README.md#storybook) for startup instructions and the mocks used by each catalog.

## 1. Find the relevant story

Run commands from the repository root.

```bash
rg --files apps/web/src -g '*.stories.ts' -g '*.stories.tsx'
npm run storybook
```

Find the component through Storybook search and check its current appearance and interactions. Stories live in the same directory as their components.

| Change | What to cover in stories |
|---|---|
| Appearance, copy, or layout | Update affected stories and check long text and narrow viewports. |
| Input, selection, or dialogs | Check states before and after interactions, keyboard navigation, focus, and disabled states. |
| Fetching, saving, or asynchronous work | Provide normal, empty, pending, and failure states, plus retry and completion states where needed. |
| Bug fix | Select or add a story that reproduces the original problem and verifies the result visible to the user. |
| API or internal logic only | Use relevant existing tests. Update stories as well if UI states or interactions are affected. |

Reuse states already covered by existing stories. You do not need to add every possible combination of props.

## 2. Use existing components and mocks

Import the same components as the application. Use fixed data and mock callbacks for states that props can express, without duplicating a screen for a story.

| Implementation example | File |
|---|---|
| Props, input, and callbacks | [ChatComposer](src/components/chat/ChatComposer.stories.tsx) |
| Dialogs, keyboard navigation, and focus restoration | [TagCreateDialog](src/components/video/TagCreateDialog.stories.tsx) |
| Authentication, Query, tRPC, and REST basics | [ApiMocks](src/lib/ApiMocks.stories.tsx) |
| SSE progress, completion, and interruption | [ChatPanel](src/components/chat/ChatPanel.stories.tsx), [SSE mock](.storybook/mocks/chatPanel.ts) |
| Real drag-and-drop context and reordering | [SortableVideoItem](src/components/video/course-detail/SortableVideoItem.stories.tsx) |

- Put shared data in [fixtures](.storybook/fixtures/) and use `import type` for API-derived types. Keep dates, IDs, and input text fixed.
- Use the [shared mocks](.storybook/mocks/network.ts) for components that depend on Query or APIs. Set up states with `success`, `pending`, and `failure`, and register the required procedures.
- Set the authentication state with `parameters.api.auth`. See the [README's API mock instructions](README.md#stories-that-depend-on-authentication-or-apis) for the Router, Query, authentication, and notification providers supplied by the shared decorator.
- Set `parameters.docs.story.inline: false` for API-dependent Docs that use the shared Query cache.
- Reset mock registrations and attempt counts in `beforeEach`. Clean up custom timers, listeners, and streams so rerunning a story or switching stories produces the same result.

The shared MSW setup blocks unregistered requests to real APIs and external media. Add the required mock when a network error occurs. Keep credentials and real user data out of fixtures.

In `play`, select the elements users interact with through queries such as `canvas.getByRole`, perform actions with `userEvent`, and check the result. Wait for asynchronous UI updates with `findByRole` or `waitFor`. Use fixed delays only when testing time itself, such as a polling interval.

Recharts replaces sector DOM elements during animation, so waiting for an element count does not necessarily make the interaction target stable. The [FeedbackDonutChart hover story](src/components/dashboard/FeedbackDonutChart.stories.tsx) emulates `prefers-reduced-motion` within that story and tests interactions using the library's reduced-motion behavior. Forward other media queries to the browser and restore the setting during cleanup. Isolate stories that change browser-wide settings in Docs with `parameters.docs.story.inline: false`. Keep the normal animation in a separate story; do not hide instability with fixed sleeps or longer timeouts alone.

## 3. Verify the changed behavior

For the first run, prepare dependencies and Chromium using the README instructions. Start with the affected file to make failures in the changed stories easier to identify.

```bash
npm run test:storybook -- src/components/chat/ChatComposer.stories.tsx
```

The file argument is relative to `apps/web`. Each story and its `play` function run in real Chromium.

For changes to appearance or interactions, also check the following in Canvas:

- Japanese and English, Desktop and Mobile, and affected states such as long text and empty data.
- Tab navigation, Enter/Space activation, opening and closing dialogs, and focus during processing and after a failure.
- Prevention of duplicate actions while saving, cancellation controls, and preservation of input after a failure.
- Isolation of mocks, network activity, and selection state when rerunning or switching stories.

Stories share the application's translation dictionaries and CSS. Switching languages does not translate fixture text, so use English fixtures when checking English content.

Run all stories for changes to shared CSS, providers, mocks, or dependencies that can affect other stories. Run relevant unit tests when changing application or hook logic.

```bash
npm run test:storybook
npm run typecheck --workspace @videoq/web
npm run lint --workspace @videoq/web
npm run build:storybook
```

Run unit tests with `npm test --workspace @videoq/web` and build the application with `npm run build --workspace @videoq/web`. Use the checks appropriate to each change without duplicating tests of the same internal implementation in both unit tests and stories.

## 4. Report validation in the PR

Describe the specific behavior before and after the change and report the checks you ran. For UI changes, list the relevant story names and files, and include screenshots when they help a reviewer assess the appearance. If no story needs to be added or updated, identify the existing story that covers the change or explain why the UI is unaffected.

Reviewers can check the static build and Chromium test results in the [CI](../../.github/workflows/ci.yml) job named `Frontend Storybook`. Also check `Frontend Lint & Type Check`, `Frontend Tests`, and `Frontend Build` on the same PR. Path filters skip these jobs for unrelated changes.

Ordinary PR and push CI does not store the static site. Run CI manually (Actions → CI → Run workflow) to get a `frontend-storybook` artifact, retained for seven days. Download and extract it, run the following command in the extracted directory, and open the displayed local URL.

```bash
python3 -m http.server 6007 --bind 127.0.0.1
```

Serve the files over HTTP instead of opening `index.html` directly. Stop the server with Ctrl+C when finished.

## Troubleshooting

| Symptom | What to check |
|---|---|
| Chromium is missing | Run `playwright install chromium` as described in the README. |
| An unregistered API or external URL causes an error | Check the required handlers and that the authentication fixture matches the procedure. Compare errors in intentional failure stories against their expected behavior. |
| A module fails to load | Check the test logs for dependency re-optimization. If a new dependency causes it, inspect `optimizeDeps.include` in the [Vitest configuration](vitest.storybook.config.ts). |
| An assertion is unstable immediately after an interaction | Wait for network requests to start or finish and for the UI to update. Do not work around the problem with fixed sleeps or longer timeouts alone. |
| Only the next story fails | Check initialization and cleanup of Query state, mocks, timers, and listeners. |

## Accessibility checks

The following components and pages set `parameters.a11y.test: 'error'` in their story metadata. Automated checks run in `test:storybook` and the CI job `Frontend Storybook`; violations fail the run. This setting also applies to stories added to the same files.

| Coverage | Stories |
|---|---|
| Notifications and confirmation dialogs | [FeedbackProvider](src/components/common/FeedbackProvider.stories.tsx), [MessageAlert](src/components/common/MessageAlert.stories.tsx) |
| Loading and processing states | [LoadingSpinner](src/components/common/LoadingSpinner.stories.tsx), [StatusBadge](src/components/common/StatusBadge.stories.tsx) |
| Forms and authentication errors | [FormField](src/components/auth/FormField.stories.tsx), [ErrorMessage](src/components/auth/ErrorMessage.stories.tsx) |
| Course sharing notice | [CourseSharingNotice](src/components/video/course-detail/CourseSharingNotice.stories.tsx) |
| Landing page and shared color theme | [LandingPage](src/pages/LandingPage.stories.tsx), [VideoQTheme](src/styles/VideoQTheme.stories.tsx) |

To check only the shared components and form/authentication stories, run:

```bash
npm run test:storybook -- src/components/common src/components/auth/FormField.stories.tsx src/components/auth/ErrorMessage.stories.tsx
```

Other stories inherit `test: 'todo'` from the [shared configuration](.storybook/preview.tsx) and report violations without failing. To expand coverage, add `parameters: { a11y: { test: 'error' } }` to the component's metadata, check each story's rendered and post-interaction states, and fix any problems. Do not disable rules or revert to `todo` merely to make the checks pass. Record the reason, a reproducing story, and a tracking issue for any necessary exception. See the [Storybook accessibility documentation](https://storybook.js.org/docs/writing-tests/accessibility-testing) for configuration details.

Passing automated checks does not complete an accessibility review. Check the Accessibility panel's items that require manual review (Incomplete), keyboard navigation, focus, and screen reader behavior. To check intermediate interaction states, add stories that end in the state you need to inspect.
