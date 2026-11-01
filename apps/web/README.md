# VideoQ Frontend

The VideoQ frontend, built with React, TypeScript, and Vite.

## Development

```bash
cd ../..
npm ci
npm run dev:web
```

Key verification commands:

```bash
npm run typecheck --workspace @videoq/web
npm run lint --workspace @videoq/web
npm test --workspace @videoq/web
npm run build --workspace @videoq/web
```

## Routing and layouts

Shared layouts are managed by parent routes in `src/App.tsx`. Add new pages as children of the appropriate parent route.

- `AppRouteLayout`: Home, lists, settings, administration, pricing, terms, and video/course details. The header persists across routes; detail pages omit the footer. Each View manages its content width and tab layout.
- `AuthRouteLayout`: Sign-in, sign-up, email verification, course invitations, and related pages. Shares the authentication header and content width.
- Public shared pages and the `/try` demo have their own layouts.

Page and video Views return only their main content. Lint rules prohibit direct imports of `AppPageShell`, `AppNav`, `AppFooter`, `AuthLayout`, and similar layout components. Add regular pages to `appPageRoutes` in `App.tsx`, and use `handle` to specify the selected navigation item and required layout variant. `AppRouteLayout` matches the same definitions through `matchRoutes`, keeping path precedence, case sensitivity, and URL encoding behavior consistent with the router.

`LocaleGate` normalizes the language prefix before rendering, using the locale parameter parsed by the router (`/%65n/...` → `/en/...`, `/ja/...` → `/...`). It preserves encoding outside the prefix, query strings, and hashes, and replaces the history entry rather than adding one.

`RouteContent` places `Suspense` and its error boundary inside the main content so the layout remains visible during initial code loading or rendering errors. API loading, failure, and empty states are handled within the content. The content is not remounted based on the URL query string, preserving input focus and edits when search filters change.

The home landing page is included in the initial bundle and displays without waiting for a session check. Only after sign-in is confirmed does the app lazy-load `HomeDashboard` and fetch account, video, and course data.

`src/__tests__/App.navigation.test.tsx` verifies navigation, loading states, and interactions during errors using the real router, translations, and navigation. Use this integration test to check parent layouts in addition to individual page tests. Check browser rendering and interactions in `Application/Navigation` (`src/App.stories.tsx`).

## Video registration

`prepareVideoUpload` in `src/lib/videoUpload.ts` validates form input and returns typed data for file uploads or YouTube registration. `useVideoUpload` passes the submission-time validation result directly to `runUploadWorkflow`. Input types for YouTube registration and tagging come from the tRPC client.

Validation on file selection displays format and size errors immediately. Submission validates the edited input again against the current file size limit. If only tagging fails after video registration succeeds, the workflow returns a warning to avoid registering the video again.

## Storybook

See the [Storybook change and review workflow](STORYBOOK.md) for adding, updating, and reviewing stories when changing the UI.

Use the Node.js version in `.node-version`. Run these commands at the repository root:

```bash
npm ci
npm run storybook          # http://127.0.0.1:6006
npm run build:storybook    # apps/web/storybook-static
npm exec --workspace @videoq/web -- playwright install chromium
npm run test:storybook     # Verify all stories and play interactions in Chromium
```

The toolbar switches between Japanese/English and Mobile (390px), Tablet (1024px), and Desktop (1280px).
The catalog covers chat answers, message bodies, search progress, and input fields; video upload forms and buttons;
authentication forms and fields; error and notification banners; loading states; confirmation dialogs; and toasts.
Video cards and lists, tag badges, selection and filtering, and processing status badges can be checked with fixed counts and tag volumes.
Chat lists and history cover long conversations, waiting for only the final answer, authors, feedback states, and CSV export in progress.
Analytics dashboards, time-series charts, and feedback pie charts include empty data and skewed values.
Tag and course creation dialogs cover input, previews, creation in progress, and retry after failure.
The catalog also includes page headers, navigation for different sign-in states, and listing/revoking OAuth-connected apps.
Upload and tag management modals cover nested tag creation, submission in progress, deletion confirmation, and retry after failure.
Use Controls to change props and Actions to inspect callbacks for submission, feedback, video citations, and confirmation results.
Form input updates story-local state; submitting forms does not send authentication, upload, or AI requests.

`Common/FeedbackProvider` uses the real Provider to open confirmation dialogs and notifications in Canvas.
Buttons reopen them; changing confirmation text or notification arrays in Controls resets the state.
Notifications normally use `durationMs: 0` to stay visible; `AutoDismiss` verifies automatic dismissal after one second.
`ConfirmWithKeyboard`, `CancelConfirmation`, and `DismissWithKeyboard` show the state after interaction.
For form fields, `KeyboardInput` verifies typing and focus.

`Chat/ChatMessagesView` creates a scroll ref and feedback state for each story.
The start/end buttons in `LongConversation` scroll the fixed-height conversation area; the `height` Control changes its height.
`AwaitingLastResponse` verifies that earlier empty answers do not show a waiting indicator, and `FeedbackUpdating` verifies that only the item being updated is disabled.
`Chat/ChatHistoryView` displays fixed ISO timestamps in the viewer's time zone and the app's selected language.
`KeyboardExportAndCitation` operates CSV export and citations by keyboard.
CSV export only records a mock callback; no file is downloaded.

`Dashboard/` switches between fixed dates and aggregates without an API connection, showing question trends and user feedback.
Charts have a parent with a defined width and render a 220px-high SVG through the real `ResponsiveContainer`.
`NarrowContainer` and `EnglishNarrow` use a 280px parent width; `NinetyDays` uses 90 days of data.
`KeyboardTooltip` verifies arrow-key interaction after focus and, for time-series charts, opening/closing with Enter.
Pie chart keyboard interaction uses the [Recharts 3.8.1 fix](https://github.com/recharts/recharts/pull/7140).
`HoverTooltip` checks mouse interaction with pie charts; `AllZeroHidden` checks that charts are hidden when all values are zero.
Recharts is pre-optimized in `vitest.storybook.config.ts` to prevent dependency optimization from reloading the first browser test. Vitest uses the same major version as the API and limits concurrent Chromium pages to two.

`Video/TagCreateDialog` and `Video/VideoCourseCreateModal` open the real dialogs from buttons.
`KeyboardCreate` checks typing, tag color selection, submission, and focus returning to the trigger; `CancelAndReopen` checks input reset.
`Creating` holds `onCreate` pending so inputs and closing stay disabled. Rerun the story to reset it.
`CreateFailed` displays a course creation error; `FailureThenRetry` sets up an initial failure and successful retry on each run.
Tag creation failures are logged only to the console, matching current behavior; form values remain available for retry.
The `EscapeRequest` play function uses the native `cancel` event to verify a close request. The Escape key also works in Canvas.
No API requests are made; inspect creation data and close callbacks in Actions.

`Layout/AppPageHeader` covers titles, descriptions, badges, optional actions, long text, and Japanese/English mobile views.
`Layout/AppNav` covers signed-out, regular user, and administrator states, selected pages, menus, and language switching.
Below 1280px, links and sign-out are grouped in the menu. `EnglishAdministratorTablet` verifies that action buttons fit within a 1024px screen.
Opening and closing use the [W3C disclosure navigation pattern](https://www.w3.org/WAI/ARIA/apg/patterns/disclosure/examples/disclosure-navigation/):
Tab moves through links; Escape closes the menu and returns focus to the trigger. Language selection also returns focus to the trigger.
`Logout` receives a successful MSW response and navigates to a sign-in page placeholder; `LogoutPending` checks disabled controls while pending.
The authentication fixture itself is fixed. The language setting in localStorage is restored after each story.

`Auth/ConnectedAppsSection` uses the real Better Auth client, with MSW returning REST responses for consent lists, public client names, and revocation.
Fixed ISO dates are displayed in the selected language and viewer's time zone. The current adapter always converts expiration to null, so the stories include the no-expiration "—" display.
`LongContentMobile` horizontally scrolls a table with long app names and scopes; `EnglishMobile` checks English rendering.
`RevokePending` and `RefetchPending` disable all revoke buttons from the start of revocation until the refreshed list has loaded.
`RevokeSucceeded` verifies that only the selected entry is removed; `FailureThenRetry` covers retry after failure; `KeyboardRevokeLastApp` checks focus on the result after removing the last entry.
On rerun, `beforeEach` recreates the consent list and attempt count. No real connections are revoked.

`Video/VideoUploadModal` replaces only `useVideoUpload` with a stateful fixture, reproducing input, tag selection, 46% progress, success, warnings, and failure.
It does not perform real uploads, YouTube retrieval, or upload validation; existing hook unit tests cover validation and network requests.
Tag listing and creation use the real `useTags` and tRPC client with MSW responses. `TagCreating` keeps the nested dialog pending.
`TagFailureThenRetry` fails tag creation only on the first attempt. Current behavior logs the error to the console and preserves input for retry.
File selection uses DataTransfer to place a small dummy File in a native FileList.
Because `userEvent.upload` alone does not satisfy Chromium's required-file validation, this reproduces selection while retaining form validation.
Regular stories use `autoCloseDelayMs: null` to preserve the success state. `AutoClose` uses the app's default 2000ms delay to check closing, focus restoration, and reset when reopened.
Timers are cleared when hidden, unmounted, or conditions change. `FilePickerCancelled` verifies that cancelling the OS file picker does not close the modal.

`Video/TagManagementModal` uses the real `useTags` and MSW to show lists, empty states, long text, many tags, deletion in progress, and deletion failure/retry.
Focus moves to Cancel when confirmation opens, back to the original delete button on cancellation, and to the heading after deletion. Confirmation buttons wrap in rows with long text.
`ErrorOutsideScrollArea` fails deletion of the last tag and verifies that the error outside the list fits on a mobile screen.
`KeyboardDeleteLastTag` deletes the last entry with Tab and Enter. Closing and all delete actions are disabled during deletion.
Mock attempt counts and tag lists reset for each story; the upload hook mock is removed afterward.
Pending tag operations are released at story completion, so an error from an old request may appear in the console when switching stories.

`Video/CourseParticipantsDialog` uses the real tRPC client and confirmation dialog. MSW simulates participant/invitation lists and invitation, resend, cancellation, and member removal operations.
`MixedRecipientPreview` and `MixedInviteResults` cover valid, invalid, duplicate, already-participating, and already-invited recipients.
Stories include loading, empty, fetch failure, pending operations, operation failure, retry, deletion confirmation, Japanese/English, mobile, long email addresses, and many rows.
Closing is disabled while invitations are sent. Focus moves to send results, operation errors, and the heading after row removal, then returns to the original button on close.
`DeliveryPolling` and `DeliveryFailed` transition from queued to sent/failed at the production interval of 3000ms; `PollingStopsWhenClosed` verifies polling stops after closing.
Unit tests also verify the 30-second delivery tracking limit and stopping when hidden/unmounted. Queries, timers, mock lists, and attempt counts reset when switching stories.
Shared MSW helpers release pending requests at completion. No email delivery or participant changes are sent to a real server.

`Chat/ChatPanel` uses the real `useChatMessages` / `useChatHistory` with MSW. Typed SSE events are written to a `ReadableStream` to hold initial waiting, searching, search complete, partial answer, complete, HTTP failure, and SSE error states.
`ProgressToComplete` sends events sequentially from its play function; `InterruptedResponse` / `RetryAfterInterruption` check interruption during an answer and resubmission. As in production, received answer deltas are batched with `requestAnimationFrame` for the next render, and stories wait for the text update and completion notification. Hidden tabs finalize the answer without waiting for a render.
`CompleteWithOpenConnection` verifies completion even when the connection stays open after done; `UnmountDuringResponse` verifies that removing the view aborts the request and that old answers do not appear when it is shown again.
Stories release streams, pending CSV requests, and abort listeners on completion; React also cancels fetches and scheduled renders.
Stories cover regular chat, shared links, history retrieval, feedback updates, keyboard submission/citations, long text, and Japanese/English mobile views. History retrieval failures display an error distinct from an empty list.
`ExportCsv` generates a fixed `storybook-chat.csv`. CSV/feedback failures are logged to the console, matching the current hooks, and can be retried. No external AI or real API is contacted.

`Video/TranscriptPanel`, `Video/VideoDetailEditDialog`, `Video/SortableVideoItem`, `Video/PickFromLibraryDialog`, and `Video/ShareLinkDialog` are real components extracted from the video/course detail pages. The existing detail pages use these same components.
Transcript search, active rows, editing/saving, video information and tag editing, video row selection/deletion restrictions, and share link states are reproduced with fixed data and controlled props. Save, delete, and copy callbacks are recorded within the story; no real data is updated and nothing is written to the clipboard.
`SortableVideoItem` uses the real DnD context and sensors. `Dragging` shows dragging in progress, `KeyboardReorder` checks reordering with Space → arrow keys → Space, and `CancelDrag` checks cancellation. Stories also cover reordering restrictions on mobile, for members, and during deletion.
`PickFromLibraryDialog` uses real Query/tRPC with MSW to reproduce exclusion of existing videos, 300ms search, tags, status, sort order, multiple selection, adding, failure, retry, and partially added selections. On failure, it preserves selection and focuses the error. Selection, filters, and closing stay disabled until adding and refetching finish.
Each component has Japanese/English, mobile, and long-text stories. Transcript and video rows support keyboard selection; editing and add-video dialogs return focus to the trigger when closed. Existing story/component cleanup ends pending API requests and search timers.

Add stories in `*.stories.tsx` files alongside the target components.
Put shared data in `.storybook/fixtures/` and use `import type` for API-derived types.
Use small, fixed local fixtures for images and videos so stories do not depend on external media.
Video cards use the two-second WebM in `.storybook/fixtures/media/`. MSW intercepts thumbnail requests for a fixed YouTube ID
and returns a local SVG. `HoverPreview` verifies video playback/stopping; `YouTube` verifies image loading.
MSW uses the Storybook-specific `.storybook/public/mockServiceWorker.js`. When updating MSW,
regenerate the worker with `npm exec --workspace @videoq/web -- msw init .storybook/public --save`.
Media mocks follow the [Storybook network mocking guide](https://storybook.js.org/docs/writing-stories/mocking-data-and-modules/mocking-network-requests).
Translations use the app's actual dictionaries and CSS. Input text and sample answers are fixed fixtures and are not automatically translated when switching languages.

The shared decorator provides MemoryRouter, I18nextProvider, and a QueryClientProvider
using the `appQueryClient` referenced by the app's tRPC options proxy.
Route-dependent components can specify `parameters: { pathname: '/videos/7' }`.
English uses the `/en` prefix and `:locale`; Japanese has no prefix, matching the app.
Stories with `parameters.api` also receive AuthProvider and FeedbackProvider.

### Stories that depend on authentication or APIs

`Foundation/ApiMocks` is a minimal example using the real `useAuth`, TanStack Query, tRPC transport, and `apiClient`.
It covers success, empty, pending, failure, regular user/administrator/signed-out states, mutations and retries, Japanese/English, mobile widths, and long text.
`MixedBatchAndInputs` verifies multiple GET and POST procedures, input mapping, and mixed success/failure responses (HTTP 207).
`KeyboardMutation` checks updates through Tab/Enter and changes to the shared cache; `MutationPending` checks disabled controls during updates.
`RestMutation` simulates API key creation through Better Auth REST with fixed values.
`UnmockedRequestsBlocked` verifies that unregistered API GET/POST, external image, and tRPC requests are blocked, intentionally logging MSW errors to the console.

Mocking uses [Storybook module mocks](https://storybook.js.org/docs/writing-stories/mocking-data-and-modules/mocking-modules) and MSW.
Only the two read functions in `authSession.ts` are replaced with `sb.mock`, producing views independent of Better Auth session subscriptions and cookies.
The session and `account.me` are configured from the same fixture in `.storybook/fixtures/auth.ts`.
Specify `authFixtures.loggedOut / user / admin` or `authFixture(profile)` instead of overriding `account.me` separately.
When signed out, the session is null and direct calls to `account.me` return 401. Sign-in/sign-out state transitions themselves are outside this fixture's scope.
REST operations such as API key management use the real Better Auth client, with only responses supplied by MSW.
tRPC reproduces batch inputs, outputs, and errors according to the [official HTTP specification](https://trpc.io/docs/rpc).

```tsx
import { authFixtures } from '../../../.storybook/fixtures/auth';
import { tagPage } from '../../../.storybook/fixtures/api';
import { success, pending, failure, trpcQuery } from '../../../.storybook/mocks/network';

export const Loaded = {
  parameters: {
    pathname: '/videos',
    api: {
      auth: authFixtures.user,
      trpc: [
        trpcQuery('tags.list', success(tagPage)),
        trpcQuery('account.integrationApiKeys', success([])),
      ],
    },
    docs: { story: { inline: false, height: '520px' } },
  },
};
// Loading: trpcQuery('tags.list', pending())
// Error:   trpcQuery('tags.list', failure('Failed to fetch', 500))
// Empty:   success({ data: [], meta: { total: 0, limit: 100, offset: 0 } })
```

`trpcQuery` / `trpcMutation` check procedure names, inputs, and outputs against AppRouter types.
In addition to fixed responses, they can use input values, as in `trpcMutation('tags.create', input => success({ ...tagFixture, ...input }))`.
Register REST handlers through `restPost` or standard MSW `http.get` / `http.post` calls in `api.rest` or `beforeEach({ msw })`.
Mutation requests can also use pending responses released at completion, such as `restPost('/api/auth/sign-out', pending())`.
For responses that change by attempt count, recreate the counter and handler inside `beforeEach`, as in `IntegrationFailureThenRetry`.
These can be combined with existing image mocks in `parameters.msw`.

Storybook and the browser project fix `VITE_API_URL` to `/api` and disable direct S3 uploads; they do not inherit real environment settings.
MSW rejects and blocks undefined API, write, and external URL requests. Local display assets remain accessible.
Unregistered tRPC procedures also fail, so explicitly mock every required operation.
At the start and end of each story, queries are cancelled, caches cleared, and authentication mocks and handlers reset.
Pending responses do not create long-running timers; they are released on request abort or story completion.
Component polling and subscriptions stop on unmount. Always clean up story-specific timers and listeners through the return value of `beforeEach`.
Because stories use the same singleton cache as the app, isolate API-dependent Docs in separate iframes with `inline: false`, as shown above.
For incremental SSE responses and interruptions, see the [ChatPanel stories](src/components/chat/ChatPanel.stories.tsx) and [dedicated mock](.storybook/mocks/chatPanel.ts).

`npm test` and `test:coverage` run the existing jsdom tests (the unit project).
Storybook runs as a separate browser project and does not reuse the API mocks in `vitest.setup.ts`.
`typecheck` checks the app and Storybook separately.
CI runs a static build and verifies stories in Chromium.
Accessibility checks are required for the components and pages listed in the workflow guide, including shared notifications, loading indicators, forms, and the landing page; violations fail CI. Other components report findings only. See the [workflow guide](STORYBOOK.md#accessibility-checks) for the covered components and how to add more.

## API client

The SPA's typed API shares `AppRouter` from `@videoq/trpc` and connects to
`/api/trpc`. `QueryClientProvider` in `src/main.tsx` shares the cache;
`src/lib/trpc.ts` defines the client and `@trpc/tanstack-react-query` options proxy.
Views and hooks use `useQuery(trpc.*.queryOptions(input))` /
`useMutation(trpc.*.mutationOptions())`. `src/lib/api.ts` contains only
protocol-specific adapters for operations outside tRPC, such as SSE,
multipart/direct uploads, CSV, media URLs, and Better Auth.

## Cloudflare Workers

The frontend is published through the `videoq-web` Worker with Static Assets.
Configuration lives in `wrangler.jsonc`; HTML language and SEO rewriting lives in
`worker/index.ts`. `videoq-api` and `videoq-docs` are separate Workers.

```bash
# repository root
npm run build
npm run test:worker --workspace @videoq/web
npm run preview:worker --workspace @videoq/web
npm run deploy:web
```

GitHub Actions CD automatically updates the frontend after push CI succeeds on `main`.
It watches `apps/web/**`, `packages/trpc/**`, the root package/lock files, and CI/CD configuration.
Production Vite public variables live in `.env.production`. The API uses `/api` on
the same origin; uploads use signed R2 URLs. Never put secrets in `VITE_*` variables.

`videoq.jp` and `www.videoq.jp` are configured as Custom Domains, with www redirected to the apex.
Existing API Worker routes handle `/api/*`, `/.well-known/*`, `/health`, and `/ready` first.
Other requests use Static Assets and the SPA fallback, with HTML SEO information updated before serving.
`public/_headers` defines a single `/*` rule shared by static assets and Worker-generated responses.

Use `npm run preview:worker --workspace @videoq/web` to check local serving.
The local environment uses noindex and does not connect to the production API.

After changing Worker bindings, run `npm run cf-typegen --workspace @videoq/web`
and commit the generated `worker/env.d.ts` as well.

## Digital Agency UI

Only components in use are synchronized.

```bash
npm run ui:check # dry-run
npm run ui:sync  # synchronize
```

The component list is managed in `scripts/sync-digital-agency-ui.mjs`.

### VideoQ color theme

Load `src/styles/videoq-theme.css` after the generated `digital-agency.css`.
Edit this file when changing landing page and shared UI colors.
Keep `digital-agency.css` and `digital-agency.tokens.json` as upstream data.

- `brand` is the blue used on the landing page and primary buttons; `ink` / `ink-muted` are main and secondary text colors.
- `page` / `surface` / `sage` are used for pages, inputs/cards, and subtle backgrounds.
- `key-*` and `blue-*` are aligned across buttons, links, selected states, and headings.
- `solid-gray-*` provides navy-toned text colors and neutral colors with pale green tones.
- `line` / `border-border` are for decorative separators. Input borders use the existing `solid-gray-600` to maintain the contrast needed to identify them.
- Pair `lime-accent` with `on-lime-accent`. Preserve the meanings of error, warning, success, and keyboard focus colors.

Use the `Design system/VideoQ theme` story to review buttons, forms, and selected states together.
After synchronizing upstream files, verify that `index.css` still loads `videoq-theme.css` last.

## Instructor landing page

`/` and `/en` are landing pages for course creators, instructors and training owners: automatic answers to student questions from their lecture videos (see PR #1249, 2026-10-30).
Visitors can switch between online course, school and internal training examples. The page only claims features that exist today: course share links without login, member invitations, AI answers billed to the course owner, the course dashboard and question history export.
Free-tier information comes from the same `billing.plans` source as the pricing page; if it cannot be loaded, visitors are directed to the pricing page.

The Japanese and English landing pages use matching 30-second, 1920×1080, 16:9, 60 fps Remotion films (`ProviderDemo`).
`LandingDemoVideo` uses `public/demo/provider-demo-{ja,en}.mp4`, WebP posters, and VTT captions.
It uses `preload="none"`, does not autoplay, and displays standard video controls after explicit playback.
If playback fails, it prompts the visitor to reload; the sign-up path remains available.
Viewing the landing page or playing the video does not call course APIs or AI services.

The film is a **recreated walkthrough using real data**, not a screen recording. After an opening labelled as an illustration,
it shows the instructor uploading a lecture and sharing the course, a student asking a question and playing the cited scene,
and the instructor finding that question in the conversation history. The answer, citation and capture time come from
`apps/demo-video/content/answer.json`, which was produced by the regular upload, transcription, indexing and RAG flow.
The English edit translates the UI, question and captured answer while preserving the citation range, and the page discloses this.

See [demo-video/README.md](../demo-video/README.md) for production steps and course registration.
The demo can be served entirely as static files. Registering the course in the public environment is not required to publish the landing page.
`worker/landing-media.ts` handles MP4 Range requests and limits reads to 16 MiB per video.
Legacy `explain-{ja,en}.mp4` / `student-demo-{ja,en}.mp4` URLs remain for compatibility.

### No-signup demo

`/try` and `/en/try` let visitors ask the sample course `PUBLIC_DEMO_SHARE_SLUG` (`packages/trpc/src/public-demo.ts`) without an account. Each question uses the dedicated demo owner's allowance and the per-IP limit of 10 questions per hour. See [the production preparation runbook](../../docs/operations/public-demo.md) and [demo-video/README.md](../demo-video/README.md). The on-prem build omits this page.

### Instructor ads

Instructor ads use the fixed cohort below and are counted under audience `creator`.
The Japanese URL is `https://videoq.jp/?utm_source=x&utm_medium=paid_social&utm_campaign=instructor_202611&utm_content=demo30_ja`.
The English URL is `https://videoq.jp/en/?utm_source=x&utm_medium=paid_social&utm_campaign=instructor_202611&utm_content=demo30_en`.
Add `audience=school` or `audience=training` to a URL to count a school- or training-targeted ad under that audience instead.

### Student ad retest (historical)

The October 6, 2026 retest directed Japanese and English ads to the student landing page.
Ads share a 15-second square format; landing page videos share a 30-second landscape format.
Previous student ads, this retest, and teacher ads are tracked as separate acquisition sources.
Checks cover sign-up, video registration acceptance, and the first answer in addition to clicks.
Whether students can obtain videos they are able to use remains a hypothesis to test.
Ad budgets, regions, and delivery status are managed in the X Ads dashboard.

### Measuring results

Only in production on `videoq.jp`, `POST /__events/landing` records structured events
with `kind=landing_funnel` and `version=student-v1` in the existing Workers Logs.
The log `version` indicates compatibility with the existing event format, not the landing page's target audience.
No new external analytics service or database is required.

| Event | Meaning |
| --- | --- |
| `landing_view` | Landing page viewed |
| `demo_open` | In-page link to the demo clicked |
| `demo_engaged` | Demo video playback started |
| `demo_complete` | Demo video playback ended |
| `signup_click` / `signup_view` | Sign-up link clicked / sign-up page reached |
| `email_signup_created` | Email sign-up API succeeded (before email verification) |
| `email_verified` | Email verification succeeded |
| `google_auth_started` | Google authentication started (includes sign-in to existing accounts) |
| `google_signup_created` | A new user was created through Google and reached the authenticated return page in the same tab |
| `video_upload_started` | Input validation passed and a video file upload or YouTube import started |
| `video_upload_accepted` | Video registration was accepted; transcription and indexing have not necessarily finished |
| `video_upload_failed` | Video registration request failed; error text and video information are not sent |
| `first_answer` | An answer completed successfully in the service (excluding public shared pages) |
| `course_share_created` | The owner created a course share link |
| `course_invite_queued` | The owner sent a member invitation that queued at least one recipient |

Use `demo_engaged / landing_view`, `demo_complete / demo_engaged`,
`email_signup_created / signup_view`, and `first_answer / landing_view` as indicators.
For the instructor page, `(course_share_created + course_invite_queued) / video_upload_accepted` shows whether owners go on to hand a course to students.
These stages are only attributed when they happen within the same tab visit. Count sharing that happens on a later day, student questions and paid plans from the database with [`apps/api/scripts/analytics/instructor-funnel.sql`](../api/scripts/analytics/instructor-funnel.sql).
Seeking to the end can also trigger `demo_complete`, so it does not guarantee a full viewing.
Legacy `demo_question` / `demo_source` / `sample_download` events are accepted only for compatibility.
Each stage is recorded once per tab, and attribution ends 30 minutes after the last recorded event.
Names, emails, question text, video IDs, user IDs, session IDs, and UTM strings are not sent.
Events include language, audience (normally `general`; `creator` for instructor ads; `school` / `training` follow the `audience` parameter or the teacher cohort; historic student ads use `student`), sign-up button location,
and one of the fixed `acquisition` values below. Raw UTM values, URLs, and click IDs are neither stored nor sent.

| `acquisition` | Conditions on the initial landing page visit |
| --- | --- |
| `x_paid_demo15_search` | All of `utm_source=x`, `utm_medium=paid_social`, `utm_campaign=student_demo_test`, and `utm_content=demo15_search` match |
| `x_paid_student_ja` / `x_paid_student_en` | `utm_source=x`, `utm_medium=paid_social`, `utm_campaign=student_return_202610`, and `utm_content=demo15_search_ja` / `demo15_search_en` |
| `x_paid_instructor_ja` / `x_paid_instructor_en` | `utm_source=x`, `utm_medium=paid_social`, `utm_campaign=instructor_202611`, and `utm_content=demo30_ja` / `demo30_en` |
| `x_paid_teacher_qa` | All of `utm_source=x`, `utm_medium=paid_social`, `utm_campaign=teacher_qa_test`, and `utm_content=lecture_qa` match |
| `x_organic_launch` | `utm_source=x`, `utm_medium=organic_social`, `utm_campaign=launch`, and `utm_content` is `intro` / `howto` / `usecase` |
| `internal_test` | A verification visit with `measurement=test` in the landing page URL; exclude from ad results |
| `unattributed` | All other visits. Events from older clients without `acquisition` are also accepted and counted here |

The initial classification persists during the visit in the same tab, allowing events such as
`email_signup_created` to be grouped by source even after navigation to sign-up removes the URL parameters.
Attribution ends after 30 minutes without events.
Filter Workers Logs by `kind=landing_funnel` and `acquisition=x_paid_demo15_search`, then compare counts by event.
Record daily aggregates before logs expire.
The Japanese retest URL is `https://videoq.jp/?audience=student&utm_source=x&utm_medium=paid_social&utm_campaign=student_return_202610&utm_content=demo15_search_ja`.
The English URL is `https://videoq.jp/en/?audience=student&utm_source=x&utm_medium=paid_social&utm_campaign=student_return_202610&utm_content=demo15_search_en`.
Count legacy student ads under `x_paid_demo15_search` and legacy Japanese teacher ads under `x_paid_teacher_qa` separately.
The legacy English teacher URL (`teacher_qa_en_test`) was not part of the classification at the time and is `unattributed`. That source cannot be reconstructed from historical logs.
Always append `&measurement=test` when verifying behavior.
Review ad clicks, landing page views, sign-ups, and video registration acceptance separately.
`audience=school` is an acquisition classification, not evidence that a visitor is a teacher.
This measurement does not link purchases, continued use on later days, or activity on other devices.
For paid usage, combine new subscriptions in the admin dashboard with asking the user how they found the service. Do not count subscriptions as ad results when their source is unknown.
Google authentication uses Better Auth's `newUserCallbackURL`. Only new users return to
`/signup/complete`; `google_signup_created` is recorded after checking for an authenticated session
and an authentication-start event in the same tab. Google sign-in by existing users is not counted as a new sign-up.
Email sign-up uses `/signup/verified` as the return page after Better Auth verifies the email and signs the user in automatically.
When both a verified session and a successful sign-up event in the same tab are present,
`email_verified` is recorded and the user is redirected to the original destination.
Dividing spend in the X Ads dashboard by the count of `email_signup_created + google_signup_created`
gives an indicative cost limited to sign-ups observed in the same tab. It includes sign-ups before
email verification and is not the CPA for all sign-ups.

This is lightweight measurement for improvement. It does not track email verification in a different tab or activity on another device.
Data may be missing because of DNT/GPC, denied storage access, network failures, log retention limits, and similar causes.
If no event occurs for 30 minutes during video processing or another wait, a later AI answer will not be attributed either.
Each stage is recorded once per tab visit, so counts do not represent unique people or all uploads.
Do not treat a sign-up button click as completed registration or interpret these figures as the overall
sign-up rate or a precise per-ad conversion rate.

#### Production verification

Start from the landing page with `&measurement=test` appended to the ad URL. This parameter also
switches an existing acquisition classification in the tab to `internal_test`. Even after the parameter
disappears from the URL, subsequent sign-up, video registration, and answer events in the same tab
are counted as verification activity.
Verify new Google sign-ups and existing-account sign-ins separately.
Do not test with a regular ad URL, because your actions cannot be distinguished from real users.
