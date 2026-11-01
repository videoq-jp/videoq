---
title: Video navigation and visual evidence
description: Use ReAct tools to survey a lecture, narrow an interval and check visible evidence.
---

# Video navigation and visual evidence

VideoQ's [ReAct-style agent (Yao et al., 2023)](../reference/ai-references.md#react) chooses tools according to the evidence a question needs.
The navigation tools are inspired by [VideoSeek (Lin et al., 2026)](https://arxiv.org/abs/2603.20185),
implemented within VideoQ's existing course access scope and citation registry.
See [the reference and scope of this adaptation](../reference/ai-references.md#videoseek), including the authors' implementation and reusable citation.
They are not a fixed pipeline: a precise timestamp can go directly to a window
or detail inspection, and sufficient subtitle evidence needs no vision call.

| Tool | Purpose | Limit per answer |
| --- | --- | --- |
| `search_scenes` | Find subtitle scenes by meaning | 3 searches |
| `overview_video` | Survey one video's timeline with 12 subtitle excerpts and optional 16 low-detail stills | 2 calls |
| `skim_video` | Locate useful moments in a candidate interval of up to 900 seconds, with 12 subtitle excerpts and optional 8 low-detail stills | 2 calls |
| `read_video_window` | Read consecutive subtitles around a known interval | 3 calls |
| `inspect_clip` | Check diagrams, equations or labels using up to 8 high-detail stills inside a known interval of up to 180 seconds | 2 calls |
| `focus_clip` | Check brief visible steps or changes in a clip of up to 16 seconds using up to 16 high-detail stills selected approximately once per second | 2 calls |

For a normal concept question, the agent starts with semantic search. When a
diagram has no subtitle clues, it can identify the video with `get_course_info`,
call `overview_video`, skim a promising interval and focus on a relevant short
clip. Every step is optional when the answer already has supporting evidence.
The viewing tools return observations and original timestamps; the main agent
produces the answer with citations.

Highlight requests use the video's genre and evidence to select worthwhile moments.
For visual events, the agent is instructed to compare distinct candidates and check
their lead-in, action and outcome with dense frames when available. It recommends
1–3 supported intervals with a reason to watch, distinguishing actors from spectator
views and persistent notifications. This does not guarantee finding every highlight.

Viewing results report the remaining shared image/call budget and a visual status:
`observed`, `no_observations`, `unavailable` or `skipped`. Completion of a tool call
does not establish that an event was observed. One 16-image overview leaves enough
of the 48-image allowance for two 16-image focus calls; additional surveys consume
that allowance. Concurrent reservations count toward the reported remaining budget.

`overview_video` and `skim_video` work with subtitles even when visuals are
disabled, including for YouTube imports. `include_visuals=false` performs no
vision call. Their subtitle samples span time instead of taking only the first
cues; each excerpt is capped at 1,000 characters. Sampling, text truncation and
missing evidence are reported explicitly. A sampled timeline is not an exhaustive
summary, and the last subtitle timestamp is not the video's duration.

Q&A can call `read_video_window` after searching to recover neighboring subtitle
cues. This works for uploaded and YouTube videos, requires no additional model
call inside the tool, and preserves original subtitle timestamps. Each answer
allows three reads: a requested interval of at most 180 seconds, up to 30 seconds
of context on either side, and at most 40 cues / 12,000 text characters per read.
The result explicitly reports truncation. It reads the latest saved transcript;
semantic search may still use older data until reindexing finishes.

New transcription preserves original cues in the saved SRT. Semantic grouping is
performed separately when building the search index. Legacy grouped transcripts
remain readable, but reindexing alone cannot restore their original timing.
Transcript excerpts also include advisory `transcript_quality` signals for long
intervals (60 seconds or more) and highly repeated text. These are bounded text
heuristics, not ASR confidence or proof of an error. Legitimate repetition is kept;
the agent should corroborate uncertain names/counts and avoid assigning a brief
event the timestamp of an entire grouped excerpt.

Image tools are enabled by default for uploaded videos. They check diagrams,
equations and screen contents that subtitles do not establish. Overview and skim
use low image detail to find candidate moments; `inspect_clip` uses high image
detail on the coarse cache. `focus_clip` reads a separate, denser cache to inspect
short-lived visible states and changes. The agent still skips image calls when
subtitles provide sufficient evidence.

## Configuration

The API, Python worker, Docker defaults and Terraform defaults enable uploaded
video image tools and cache preparation. These are the Docker `.env` defaults:

```dotenv
VIDEO_VISUAL_ENABLED=true
LLM_MODEL=openai/gpt-6-luna
```

Recreate the API and worker to load them:

```bash
docker compose up -d --force-recreate api worker
```

For host-run API development, set the same values in `apps/api/.dev.vars`. The
Python worker needs `ENABLE_HEAVY_PIPELINE=1` for real video processing.
Image inspection and answer generation share the API's `LLM_MODEL`,
`LLM_API_KEY`, and `LLM_BASE_URL` (optional overrides of the shared provider key and `OPENAI_BASE_URL`). Hosted profiles use `OPENROUTER_API_KEY` and `openai/gpt-6-luna`. GPT-6 Luna requests use
`reasoning_effort=none`. The endpoint/model must support image inputs and strict
JSON-schema output. The normal answer model still needs tool calling. To opt out,
set `VIDEO_VISUAL_ENABLED=false` on both API and worker. Existing explicit false
overrides remain effective until changed and the processes restarted.

After transcription, new uploads register independent jobs that process the video
60 seconds at a time. The SQS event source's concurrency limit (10 in production) controls parallelism.
Interval jobs do not start one another, so long videos finish with
[AWS Lambda recursive loop detection](https://docs.aws.amazon.com/lambda/latest/dg/invocation-recursion.html)
left on. Each interval saves its images and completion state, and retries do not
reread saved intervals. Subtitle completion and visual readiness are reported
separately. A failed extraction keeps the subtitles and logs its exit code or signal.
Existing uploads can be backfilled without Whisper or embedding calls. From
`apps/worker`, with database and media storage settings configured:

```bash
python scripts/prepare_visual_frames.py --video-id 42
```

With SQS configured, the command queues the interval jobs. Local environments without
SQS process the intervals in order.

The backfill builds both caches, including dense focus data for older uploads
that already have coarse images. Embedding reindexing does not build frame caches. YouTube imports have no local
video file and cannot use visual inspection. A missing cache is reported to the
agent; it must acknowledge the unverified visuals rather than invent evidence.

## Limits and evidence

- FFmpeg selects at most 240 stills, at least 5 seconds apart. Longer videos use
  a wider interval (`max(5, duration / 240)` seconds). Stills are scaled to fit
  1024 × 1024 and retain their presentation timestamps to millisecond precision.
- One private `media/<file_key>.frames-v1.json` stores the cache, capped at 16 MiB
  including base64. A JPEG is capped at 256 KiB. Cache publication uses the video
  row lock so deletion cannot leave a late-published cache behind.
- The dense cache selects real source frames at least approximately one second
  apart, without duplicating or retiming frames. It retains millisecond PTS and
  fits images within 1024 × 1024. One private `media/<file_key>.focus-v1.bin` holds
  its index and JPEG data atomically, capped at 512 MiB, 36,000 frames and a
  2 MiB index (up to 10 hours; byte and processing limits may be reached sooner).
  No partial cache is published on extraction failure or a limit violation.
- `focus_clip` uses the half-open interval `[start_seconds, end_seconds)` of at
  most 16 seconds and up to 16 dense images. The API reads only the header, index
  and selected images, using three bounded range reads and a matching object
  ETag. It never downloads the whole dense pack. Insufficient remaining image
  budget is reported instead of silently reducing temporal density.
- All four viewing tools share at most 4 visual calls / 48 images per answer.
  Overview and focus use up to 16 images; skim and inspection use up to 8 each.
  These limits are enforced in code even for parallel requests. Image reads and
  model calls are serialized to bound memory. With `gpt-4o-mini` (including dated
  snapshots), high-detail images are sent in batches of at most four to fit its
  context window. Every selected frame is retained, with original frame indices.
  All batches in one viewing operation share a 60-second deadline and have no
  automatic retries, within the existing Q&A request deadline.
- The model returns observations by frame index. The server assigns video IDs,
  titles, timestamps and `evidence_type: "visual"`. The UI displays just the
  timestamp, which links to the sampled frame. Existing citations without this
  optional field remain valid.
- During a streamed answer, the progress row identifies the running tool and its
  activity. Expand it to see each invocation and its completion, error or
  interruption status. These live events contain only tool names, call IDs and
  statuses, not tool arguments, results or images.
- Sparse stills can miss a brief action or a changing equation; use `focus_clip`
  when finer temporal coverage is needed. Approximately 1 FPS still cannot
  establish unseen motion or sub-second events, and source gaps remain gaps.
  Empty observations are not proof of absence. A missing dense cache is reported
  explicitly and is never substituted with coarse images as dense evidence.
  FFmpeg runs during upload/backfill, not during an answer. Visual navigation
  works without subtitle search hits, but there is no visual embedding index.

Image bytes stay out of chat history and public media routes. The selected images
are sent to the configured model service. Saved context contains textual visual
observations. Video deletion and account deletion remove both caches even when
the feature has since been disabled, and failed cleanup remains retryable.

## Rollout and comparison

Both checked-in API environments and the worker default to image inspection on.
Deploying the implementation enables it for new uploads unless explicitly
overridden. `worker_visual_enabled=true` is the Terraform default. Set the API's
`LLM_MODEL` to a model that supports image input, tool calling, and strict JSON output.
No database migration or new cloud service is required. Do not put the
worker flag in SSM's app-secret JSON: the current loader only accepts its listed
secret keys. Use Lambda's environment configuration.

Start with the same uploaded lectures and questions under two settings: visuals
disabled and enabled. Include questions answerable from subtitles, questions
requiring a diagram/equation, brief actions the sampling can miss, and questions
whose answers are absent. Manually label expected answers and supporting times.
Compare answer correctness, unsupported claims, citation timing, total latency,
and provider usage. Run repeated trials because tool selection is model-dependent.

`visual_inspection` logs report viewing mode, frame count, model-call duration and prompt/output
token usage without image bytes, questions or private paths. These are the extra
vision calls, not total Q&A cost. This change does not claim measured accuracy or
cost improvements and does not introduce a post-answer scoring job.

Derived cache storage is bounded service overhead (up to 16 MiB coarse plus
512 MiB dense per video); the
existing user storage quota still counts the original upload, not this cache.
Monitor aggregate cache storage, upload processing time and model usage.
