---
title: Where data is stored
description: Storage locations for video files, search data, questions and answers, and authentication data.
---

# Where data is stored

Video files and information about those videos are stored separately. When investigating a problem, first identify which kind of data you need to inspect.

## From video to search data

```mermaid
flowchart LR
    File[Video file] --> Store[(R2 / Garage)]
    Store --> Worker[Python worker]
    Worker --> Transcript[(Transcript in videos)]
    Transcript --> Index[Generate embeddings]
    Index --> Scenes[(scene_embeddings)]
```

`videos` stores the title, owner, file reference, transcript, processing state, and related metadata. The file itself is not stored in a DB row.

`scene_embeddings` enables semantic search of transcript segments. The API converts questions into numeric search vectors and finds similar scenes within permitted videos.

## Questions and answers

```mermaid
flowchart LR
    Question[Question] --> Access[Check course access]
    Access --> Context[Retrieve metadata and subtitles]
    Context --> Answer[Structured answer and citations]
    Answer --> Browser[Stream text and validated citations]
    Answer --> Validate[Validate completed answer]
    Validate --> Logs[(chat_logs.response)]
```

`chat_logs.response` stores `segments` and server-owned `sources`. `retrieved_contexts` retains deduplicated scene text and course metadata. Partial stream events are not stored as separate chat records.

The stream's `done` follows answer persistence. Responses without a course are not saved. Retired evaluation tables retain historical data; no new scores are written.

## Other storage locations

| Data | Storage or management |
|---|---|
| Browser login state | Better Auth `session` and browser cookies |
| External API keys saved by users | Encrypted in the database |
| MCP API keys and OAuth | `apikey`, `oauth_*`, and related tables |
| Undelivered jobs | `external_tasks` |
| Worker execution records | `job_executions` |
| Transcription and visual-cache checkpoints | `video_transcription_*` and `video_visual_*` |
| Visual caches for uploads | Private `media/<file_key>.frames-v1.json` and `.focus-v1.bin` objects in R2 / Garage |

**Related:** [Data dictionary](data-dictionary.md), [ER diagrams](er-diagram.md), [Job delivery and recovery](../architecture/flowchart.md).
