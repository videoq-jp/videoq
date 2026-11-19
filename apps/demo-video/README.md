# VideoQ demo films

This package contains the current English product overview and the legacy Remotion films. Landing pages serve language-specific instructor overviews; the student film and its sample course remain for `/try`, older URLs and ads.


## Current English product overview (2026-11-20)

The README and English landing page serve a 2 min 30 sec product overview,
`provider-demo-en.mp4?v=5`. It follows the November 13 Japanese overview's nine
chapters: sources, student questions, uploads, courses, email invitations,
library/transcripts, history, integrations, and getting started. The English film
uses still captures of the current app with synthesized English narration, music,
and WebVTT captions. The Japanese film remains its separate 178-second edit.

`content/product-film-en.json` owns the English script and chapter order.
`public/product-film-en/screens/` holds reviewed English UI captures from
`apps/web/src/pages/ProductFilm.stories.tsx`. Those stories render the actual app
with local API fixtures, so no account, invitation delivery, or AI request is
needed. The question, answer, lesson and 0:00–0:54 source are translations from
the original captured demo. Student identities are fixtures. Only the math lesson
is opened; the other subjects have no simulated playback. The transcript shown
is a translated illustration of the same lesson, not a new transcription run.

To refresh captures, start the web Storybook and open the **Films / English
product walkthrough** stories in English. Capture these states after fonts and
video buffering settle: `Member` before/after sending the supplied question and
after selecting its citation (`question`, `answer`, `citation`); `Course` with
Videos selected, question history open, and Manage members open with
`learner@example.test` entered (`course`, `history`, `invite`); `Upload` with a
selected file and then the YouTube URL tab (`upload`, `youtube`); `Library`
(`library`); and `Video` before/after Edit (`transcript`, `transcript-edit`).
Do not send invitations. The upload capture hides the browser's native file
selector button so an OS-language label is not included; the selected filename
is retained. Save captures as WebP in the screenshots directory above.

```bash
# macOS: requires Samantha voice, ffmpeg/ffprobe, and Python Pillow
python3 apps/demo-video/scripts/render-product-film-en.py --prepare-only
# Review the generated chapter slides in review/product-film-en/, then export
python3 apps/demo-video/scripts/render-product-film-en.py
```

The renderer checks the 16 MiB serving limit, measured duration, every video
frame (including flashes, header stability and fast start), and audio decoding before replacing the English MP4, poster, captions and metadata.
Narration timing is measured from the generated audio; captions follow those
measurements. Generated review slides, speech and intermediate files are ignored.
Speech caches include the text, voice, and rate in their filenames, so script changes regenerate the affected narration.
Update the README and English landing copy if the duration changes, and bump
metadata / README / player test versions together for any published replacement.

The Remotion provider renderer below reproduces the **legacy 30-second** film;
it must not be used to overwrite either current provider film.

## X ad video (shared Japanese/English format, 2026-10-06)

`XAd` uses the same 15-second, 1080×1080, 60 fps composition as the live Japanese ad.
Both languages share `XAd.tsx`, `x-ad.css`, `content/x-ad-timeline.json`, and
`ProductScreen`, keeping the background, logo, layout, zoom, cursor, clicks, music,
and scene transitions consistent. Of six Japanese frames rendered for comparison,
four matched the original saved images exactly; the other two differed by only
1 and 3 intensity levels, respectively, summed across RGB.

English translations are collected in `content/x-ad-en.json`. The original course
material, question, and captured answer are translated while preserving the
0:00–0:54 citation range. This is neither a new answer from the English API nor a
speed measurement; the video explicitly states `Translated real-data demo · Waiting times shortened`.
The first scene of the course material is also translated using the original
rendering coordinates and fonts. The existing Japanese landing page video and live
ad remain unchanged.

```bash
npm run typecheck --workspace @videoq/demo-video
node apps/demo-video/scripts/render-x-ad.mjs --locale en
# Japanese comparison frames (does not overwrite the original saved frames)
node apps/demo-video/scripts/render-x-ad.mjs --locale ja --stills
```

Finished MP4 and VTT files go to `output/x-demo/`; review images go to `review/x-ad/`.
Rendering checks all 900 frames, flashes, the fixed header, ending, duration, frame
rate, resolution, fast start, and file size. Only videos that pass are exported.
X ads use the 15-second square version. Landing pages use the language-specific
product overviews described above.

## Legacy Remotion instructor demo (2026-10-30)

`ProviderDemo` is the original 30-second, 1920×1080, 60 fps film for
course creators and instructors. It runs: an illustrative hook (incoming student
questions, labelled as an illustration), the instructor uploading a lecture and
sharing the course link, the student asking a question and jumping to the cited
moment, the instructor finding that same question in the conversation history,
and an end card.

Every product screen is the web app's real code: `VideoLibraryPage`,
`VideoUploadModal`, `VideoCourseDetailView`, `ShareLinkDialog`, `SharePage`,
`ChatPanel` and `ChatHistoryView`, imported from `apps/web/src` and styled with
its compiled stylesheet, so a UI change appears here on the next render. They do
not call an API: `webpack-override.mjs` swaps only the data hooks for those in
`src/real/hooks/`, which return state derived from the current frame.
`src/real/data.ts` replays the recording in `content/answer.json` through the
app's own reducers. `ProductViewport` hosts the screens in a 1600×802 iframe so
that breakpoints, `dvh` and native modal dialogs behave as in a browser window.
The film adds only the camera, pointer, captions and header around them.
Pointer targets in `src/real/camera.ts` are measured from the rendered screens:
re-check them if a layout changes. No dashboard figures are shown because the
demo course holds only that one real question. Scene timing lives in
`content/provider-timeline.json` and film copy in `content/provider-copy.json`.

`scripts/prepare-product.mjs` runs before rendering. It writes the compiled
stylesheet, the logo and WebM copies of the lessons to `public/generated/`, which
is not committed. Chrome Headless Shell has no H.264 decoder, and the WebM files
stay under 2 MiB because Chrome preloads those fully, which keeps the native
scrubber identical on every frame.

```bash
npm run render --workspace @videoq/demo-video -- --film provider
npm run render --workspace @videoq/demo-video -- --film provider --locale en --stills
```

Output goes to `apps/web/public/demo/provider-demo-{ja,en}.mp4` with matching
WebP posters and VTT captions. Rendering needs a full `ffmpeg` with VP9 and
`ffprobe` on `PATH`, Python with Pillow, and network access for Noto Sans JP.

## Student demo (legacy landing URLs)

`npm run render` selects this film when `--film` is omitted. The landing pages no longer serve it, but its URLs stay available for compatibility.


A 30-second, 1920×1080, 60 fps walkthrough built with Remotion. It smoothly zooms to
interactions in the style of Screen Studio, showing the cursor, clicks, typing,
answers, and playback of cited scenes. It recreates VideoQ's shared course UI rather
than recording the live screen. Both languages share `StudentDemo`, `style.css`,
`content/timeline.json`, camera movement, cursor, and music. The English version
translates the visible course UI, material, question, and captured answer while
preserving the original citation range. It opens on Writing material and selects
mathematics at 2.2 seconds. Playback uses the same static slide as the original
mathematics lesson.

## Course material and the real answer

`content/course.json` contains original material for five subjects: Japanese
(argument and evidence), mathematics (derivatives), science (DNA), social studies
(supply and demand), and English (claims and reasons). Each subject has three
chapters, generated as an approximately one-minute narrated video in `public/lessons/`.

Videos are registered through the real API's normal upload flow and processed by
the regular worker for Whisper transcription, Otsu scene segmentation, and
embeddings. Transcripts and search indexes are not inserted directly from scripts.
`content/answer.json` records the answer and citations returned by the public
course's regular RAG endpoint. The mathematics citation is `0:00–0:54`, matching the
real data. The short lesson was processed as one scene, and that result is used
as-is without inventing a narrower timestamp range for the video.

This version registers and processes the course in a dedicated local environment.
Production courses are unchanged. The share slug is `videoq-campus-basics-v1`.
Landing page playback does not require requests to this course or an AI service.

## Reproduction

Run `npm ci` at the repository root and install the macOS Japanese voice `Kyoko`,
ffmpeg/ffprobe, and Python's Pillow. Rendering uses Remotion's managed Chrome
Headless Shell and PNG frames. The browser is downloaded automatically on first
use. Set `REMOTION_BROWSER_EXECUTABLE` only when using a different executable.

```bash
# Generate course material and original music (skip when using existing assets)
npm run lessons --workspace @videoq/demo-video
python3 apps/demo-video/scripts/build-audio.py

# Register under a dedicated owner with the regular API and processing worker running
npm run demo:students --workspace @videoq/api -- \
  --origin http://127.0.0.1:8787 --local-user <demo-owner-id>

# Verify the registered content anonymously
npm run demo:students --workspace @videoq/api -- \
  --origin http://127.0.0.1:8787 --check

# Refresh the real AI answer (run only for an intended update; consumes the owner's AI quota)
node apps/demo-video/scripts/capture-answer.mjs

# Type checking, editing preview, and rendering
npm run typecheck --workspace @videoq/demo-video
npm run studio --workspace @videoq/demo-video
npm run render --workspace @videoq/demo-video
# Update only the English landing page video
npm run render --workspace @videoq/demo-video -- --locale en
```

The registration CLI uses file SHA-256 hashes and a course-specific marker to
determine reuse. `--upload-only` skips waiting for processing; rerun the same command
later to resume through publication. To register in a public environment, use an
HTTPS `--origin` and `VIDEOQ_DEMO_COOKIE_FILE`. Store the cookie in a file with mode
600, and keep it out of source code, CLI arguments, and logs. Existing courses with
different material or share slugs are not overwritten. When changing course
material, switch to a new slug and register again.

The no-signup demo at `/try` serves this course from production, so register it there
before deploying the page. Use a dedicated owner and raise its AI answer limit in the
admin screen: every visitor question uses that owner's quota, and the limit caps the
monthly spend. Each IP may ask 10 questions per hour (`chat_public_demo_ip`). The slug is
also `PUBLIC_DEMO_SHARE_SLUG` in `packages/trpc/src/public-demo.ts`; keep them equal.

```bash
VIDEOQ_DEMO_COOKIE_FILE=<cookie-file> npm run demo:students --workspace @videoq/api -- --origin https://videoq.jp
npm run demo:students --workspace @videoq/api -- --origin https://videoq.jp --check
```

Use `VIDEOQ_DEMO_ORIGIN` to change the origin used to retrieve answers. After updating
an answer or its references, verify that the subject selected in the video matches
the cited material.

The 30-second version is exported to `apps/web/public/demo/student-demo-{ja,en}.mp4`
and the corresponding WebP/VTT files. Use `--locale en` / `--locale ja` to regenerate
only one language. The 15-second ad renderer does not overwrite the landing page's
served files. Rendering fails if the MP4 exceeds the 16 MiB serving limit.
Review stills are generated in `review/` (excluded from Git). Use `-- --stills` to
generate only still images.

## Editing scope

`content/timeline.json` centrally defines duration, frame rate, interaction timing,
and captions. `src/StudentDemo.tsx` defines the UI, zoom, and cursor. Camera movements
last approximately 0.4–0.6 seconds. The real answer is loaded from JSON rather than
hardcoded as a model answer. Waiting times are shortened, so the video does not
measure answer speed. The landing page also identifies it as a recreated walkthrough
based on real data. Course material and music were created specifically for this
demo; no external lesson footage or music is used.

## Frame verification

Earlier renders using desktop Chrome/JPEG included frames with duplicated screen
tiles. Rendering now uses a dedicated Headless Shell, ANGLE, and PNG, and checks
every frame in the finished MP4. `scripts/verify-video.py` checks changes in the
fixed header, isolated frames that differ sharply from their neighbors, duration,
frame rate, resolution, fast start, and file size. It has also been verified to
detect anomalies in known broken older videos. Videos that fail remain in `review/`
and do not replace existing landing page files. Results are saved in
`review/*-quality.json`. Run the following commands for manual checks.
CI's Frontend Build also checks every frame in the Japanese and English
`student-demo` MP4 files; it does not rerender them with Remotion, and it does not
run this check on the `provider-demo` files the landing pages serve.

```bash
python3 apps/demo-video/scripts/verify-video.py apps/web/public/demo/student-demo-ja.mp4
python3 apps/demo-video/scripts/verify-video.py apps/web/public/demo/student-demo-en.mp4
```

When changing the visual design, review the fixed-header inspection region as well.
If the duration changes, update the landing page translations and Storybook playback
duration, and increment `v` in the serving URL.
