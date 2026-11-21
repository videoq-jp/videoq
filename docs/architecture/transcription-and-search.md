---
title: Transcription and scene search
description: How audio or subtitles become timestamped scenes, embeddings, and evidence for Q&A.
---

# Transcription and scene search

This page follows the data prepared before Q&A and the search performed after a question arrives. Start with [How AI builds an answer](../concepts/how-ai-works.md) for a worked example.

For a walkthrough of the result students see, [try a question in the sample course](https://videoq.jp/en/try). The [AI answers guide](https://videoq.jp/en/guides/how-ai-answers-work) explains how to check an answer against its source moment without the implementation details below.

## 1. Obtain timestamped text

Whisper's model-family reference is [Radford et al. (ICML 2023)](../reference/ai-references.md#whisper). Record the selected API model or local checkpoint when describing an experiment.

| Source | Current processing | When it cannot proceed |
|---|---|---|
| Uploaded video | Read the stored file with HTTP range requests (local media is read in place), extract mono audio with FFmpeg, transcribe through the selected Whisper backend, and convert the segments to SRT | Missing file/audio, transcription failure, or an empty transcript |
| YouTube | Request subtitles through SearchAPI, trying manual subtitles first and automatic subtitles next, then convert them to SRT | Missing SearchAPI configuration or no usable subtitles |

The file upload form lets users select the spoken language, initially using the frontend display language. The selection is saved in `videos.transcription_language` and sent to Whisper for every interval, including retries. Selecting automatic detection leaves this field null; existing videos also keep automatic detection. This setting controls recognition of the source audio, not translation of the transcript.

The YouTube path does not fall back to downloading the video and transcribing its audio. According to `WHISPER_BACKEND`, the upload path uses Whisper through OpenRouter (the hosted profile), direct OpenAI Whisper (legacy), or a local compatible endpoint. Uploaded videos use four bounded SQS lanes. Cloud and NVIDIA profiles use 300-second intervals; the on-prem CPU profile uses 30 seconds (`WHISPER_CHUNK_SECONDS`, valid range 30–300). The local speech service uses whisper.cpp on CPU or vLLM on NVIDIA, with VAD/normalization and no hosted fallback. Each job seeks directly into the stored source, extracts only its interval, and saves the returned segments in PostgreSQL with source-relative timestamps. Completed intervals are reused on retry; the finalizer joins them into SRT only after every interval is saved. These are implementation choices, not a statement of a provider's current limits.

In development, disabling `ENABLE_HEAVY_PIPELINE` produces a one-second placeholder transcript. This can exercise state transitions but cannot test transcription accuracy or meaningful search. After saving uploaded-video transcription, separate jobs prepare bounded coarse and approximately 1 FPS dense frame caches by default (`VIDEO_VISUAL_ENABLED=false` opts out). A visual job failure does not discard the transcript; image-model calls happen only when Q&A invokes visual inspection. See [visual evidence](../guides/visual-evidence.md).

## 2. Group subtitles into scenes

An SRT cue contains a start time, an end time, and text. Whisper or YouTube may produce many short cues. VideoQ groups these into text scenes while keeping their position in the video.

Transcript editing and playback use the same SRT parser. Each cue requires an integer index, a complete `HH:MM:SS,mmm --> HH:MM:SS,mmm` timing line, and nonempty text. Dot milliseconds are also accepted; minutes and seconds must be below 60, and the end cannot precede the start. Invalid cues are rejected when saving and skipped when reading existing subtitles. The Python indexing parser follows the same contract, verified with shared fixtures. An empty transcript clears the subtitles.

```mermaid
flowchart TD
    S[Timestamped subtitle cues] --> T{Within the text token budget?}
    T -->|Yes| K[Keep as one scene]
    T -->|No| B[Split into smaller ranges]
    B --> T
    K --> I[Embed and store the resulting scenes]
```

The splitter adapts [Otsu's between-class variance criterion (1979)](../reference/ai-references.md#otsu) to time-ordered subtitle embeddings: it looks for a boundary that separates the before/after groups in embedding space. This is VideoQ's application of the criterion; the original paper concerns gray-level image thresholds. It repeatedly splits long ranges until each range fits the default budget of **512 tokens**. Before merging cues, it counts the joined text, including spaces between cues. A short range can remain one scene even when its topic changes; this is a length-bounded segmentation algorithm, not an LLM identifying every topic.

If a single cue itself exceeds the budget, the code splits its tokens and distributes its time interval proportionally. Each chunk is checked after the whitespace normalization used when reading SRT. Those intermediate timestamps are estimates. Two over-budget cues have only one possible boundary; embeddings are needed for semantic boundary selection only when a range has at least three cues. Embedding-contract errors fail the job. Other splitting errors keep the original SRT, so the 512-token scene size is not guaranteed on that fallback path.

## 3. Store searchable scene data

The original SRT cues are saved in `videos.transcript`. The indexing job groups those cues into search scenes, embeds each scene's text, and writes rows to `scene_embeddings`, preserving the saved playback subtitles. Embedding requests are batched in groups of 64. Each row contains text plus its vector and metadata: owner, video ID/title, scene index, and start/end times.

Indexing replaces that video's existing vector rows. API search and worker indexing must use compatible embedding models and dimensions. The current database column has **1536 dimensions**; changing a model setting alone does not migrate the column or rebuild old vectors. A changed embedding model requires reindexing the material that will be searched with it.

After initial indexing completes, Q&A can search the scenes. See [update scope and verification](#update-scope) and [video states](../design/state-diagram.md).

## 4. Search when the model requests evidence

`search_scenes` receives a natural-language query and, optionally, video IDs within the authorized course. The API:

1. Rejects requested video IDs outside the allowed set.
2. Embeds the search query through the configured embedding provider.
3. Uses PGVector similarity search, filtered by owner and allowed video IDs.
4. Returns up to `RETRIEVER_K = 20` scenes by default, including text, video title/ID, and timestamps.

For example, a query about “perpendicular vectors” may find a scene describing “an angle of ninety degrees” even if it does not repeat the question's words. Whether it succeeds depends on the transcript and embeddings.

The current application does not apply a minimum similarity cutoff or a second reranking model. It discards the returned numeric scores when preparing tool results. “20 scenes returned” therefore means candidate material was found, not that all 20 scenes answer the question. A nonempty index can return weak matches instead of returning no results.

The model can revise its query and search again, up to three times per answer. The application's scene collector deduplicates results using video ID and start/end times, assigning stable numeric source IDs (1, 2, …) within that answer. Those numbers are neither global scene IDs nor confidence scores.

## 5. Send evidence to the answer model

A scene tool result contains the citation number, video title, timestamps, and subtitle text. Course metadata comes from a separate tool. The answer model sees these results during the current tool loop and writes a response under the configured instructions.

The model returns `segments` containing text and source IDs. The API adds the corresponding source metadata, streams text and validated citations during generation, and saves the complete `ChatAnswer` after final validation. See [the answer and streaming contract](prompt-engineering.md#structured-answers-citations-and-permissions).

This path does not perform a web search. The available tools read registered course information and indexed scenes. A long-video summary is limited by the scenes actually retrieved; there is no automatic traversal of every scene to ensure full coverage.

## What changes when editing or reindexing {#update-scope}

Initial processing follows **transcription → scene indexing**, then marks the video `completed`.

Transcription completion compares the current subtitle content with its starting
fingerprint under the video row lock. It preserves intervening subtitle edits or
clears, including when the provider fails, and leaves their existing reindex job
responsible for search updates. That manual correction completes the transcription
attempt without another indexing job. Deleted videos and already completed work
are not restored; an existing indexing handoff can still resume safely.

| Operation | Updated data | How to verify completion |
|---|---|---|
| Initial upload / YouTube import | Obtain a transcript, group scenes, and create the search index | Check the video's `completed` status |
| Save an edited transcript | Save SRT and register `reindex_video_transcript` in one DB transaction. The worker replaces that video's scene text/vectors, or deletes its vectors if the transcript was cleared | Reopen the transcript to confirm saving, then check the reindex job separately |
| Reindex embeddings from Admin | `reindex_all_videos_embeddings` rebuilds search data for completed videos with nonempty transcripts, leaving stored transcripts unchanged | Match the returned job ID to worker logs / `job_executions` |

Saving identical transcript text or changing only a title or description does not enqueue a reindex. See [embedding configuration](../guides/embeddings.md) before changing models.

Full reindexing replaces each video's index in a transaction after its new embeddings
are ready. A failed video retains its previous search data, and the job fails for
retry after processing the remaining videos. Previously completed replacements stay
available; there is no initial deletion of the entire index.

Before writing, the worker locks the video's current DB row. It skips deleted
videos, uses the latest title, and retries if the transcript changed during
embedding generation. API edits and deletion use the same row lock, so older
generation results cannot restore deleted scenes or overwrite newer metadata.

### Verify a subtitle correction in Q&A {#verify-transcript-update}

1. Open a video you own, select **Edit** in the transcript panel, correct the text while preserving SRT numbering and timestamps, and **Save**.
2. Reopen the transcript to confirm persistence. The video's existing `completed` label does not confirm this edit's reindex has finished.
3. Run `docker compose logs --since=10m worker` and match `reindex_video_transcript`, the video ID, and the job ID to the save time. Check for `Successfully reindexed transcript for video …`. An operator can also verify that job's `job_executions.status = 'completed'`. Outbox completion only confirms delivery.
4. Send a new question naming the subject in the same course. Compare its citations and timestamps with the corrected transcript. Previously displayed or saved answers are not regenerated.

See [updateVideo](https://github.com/videoq-jp/videoq/blob/main/apps/api/src/repositories/video-repository.ts), [transcript reindexing](https://github.com/videoq-jp/videoq/blob/main/apps/worker/worker_python/tasks/reindex_video_transcript.py), and [full reindexing](https://github.com/videoq-jp/videoq/blob/main/apps/worker/worker_python/tasks/reindexing.py).

If a queued transcription or indexing job starts after its video has been deleted,
the worker acknowledges it without calling a provider or scheduling more work.
A video still awaiting indexing with an invalid or missing transcript fails indexing;
database and provider failures remain retryable.

## Diagnose a poor answer at the right step

| Symptom | First check |
|---|---|
| A slide's equation is missing | Whether the equation was spoken or present in subtitles |
| Names or technical terms are wrong | The stored transcript before changing the answer prompt |
| A citation starts too early or late | Original subtitle timing and any proportional split of a long cue |
| The answer discusses another lesson | Course membership, the model's selected video IDs, and the search query |
| Retrieved passages are only loosely related | Transcript coverage and embedding compatibility; no minimum-score filter currently removes weak matches |

## Implementation reference

| File | Responsibility |
|---|---|
| [transcription.py](https://github.com/videoq-jp/videoq/blob/main/apps/worker/worker_python/pipeline/transcription.py) | Audio/subtitle acquisition and the development placeholder |
| [scene_otsu/](https://github.com/videoq-jp/videoq/tree/main/apps/worker/worker_python/pipeline/scene_otsu) | Segmentation, token counting, and fallback to the original SRT |
| [vector_index.py](https://github.com/videoq-jp/videoq/blob/main/apps/worker/worker_python/pipeline/vector_index.py) | Scene embeddings and metadata storage |
| [vector-repository.ts](https://github.com/videoq-jp/videoq/blob/main/apps/api/src/repositories/vector-repository.ts) | Search scope and result count |
| [rag.ts](https://github.com/videoq-jp/videoq/blob/main/apps/api/src/lib/rag.ts) | Tool loop, scene deduplication, and citation numbering |

**Read next:** [Q&A prompts and answer persistence](prompt-engineering.md).
