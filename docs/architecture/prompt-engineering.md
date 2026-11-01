---
title: Q&A prompts and answer persistence
description: The model's inputs, tool decisions, citations, failure behavior, and answer persistence.
---

# Q&A prompts and answer persistence

Prompts contain instructions and reference material for AI. VideoQ answers using the user's question together with accessible course information and subtitles.

Start with [How AI builds an answer](../concepts/how-ai-works.md) for a complete question-to-citation example. This page explains the inputs and controls behind that example.

## What reaches the answer model

| Stage | Material passed to the model |
|---|---|
| Start of ordinary Q&A | System instructions and the latest user question; earlier conversation turns are not included |
| Tool definitions | What each tool can do, its argument schema, and instructions about when to use it |
| After a tool call | The current answer's tool-call history and returned course metadata or numbered subtitle scenes |
| Final response | The model writes using the evidence acquired during that answer |

The prompt selects language-specific instructions from `prompts.json`. Each locale supplies a complete configuration whose structure is checked by TypeScript. Selection tries the full locale, its primary language, and then the default; configurations are not merged at request time.

Course metadata includes names, descriptions, video counts, and a page of video IDs/titles/statuses. The tool explicitly omits share tokens, owner IDs, and file URLs. Descriptions can be truncated: course descriptions at 2,000 characters and video descriptions at 500, with flags indicating truncation. A missing page or truncated field must not be treated as proof that information does not exist.

Showing older chat messages in the UI does not change this Q&A input contract. Follow-up questions need enough context in their latest message.

### Client and API contract

The web client sends its selected UI language in `Accept-Language` for both SSE and tRPC requests. It reads the language for each request, so switching between Japanese and English also changes the answer instructions without reloading the page or relying on the browser's language preferences.

Q&A deliberately remains a single-question feature so each request specifies its own subject and retrieves evidence without inheriting earlier answers. This applies to authenticated chats, shared-link chats, and Q&A without a course. The browser sends one `user` message. The streaming endpoint (`/api/chat/messages/stream`) and `chat.send` still accept a `messages` array for compatibility, but Q&A selects only its latest `user` entry; older entries do not provide context.

For “What is the dot product?” → “Give me an example”, the second request is independent. It must not inherit “dot product” from the first request. A particular clarification response is not guaranteed by code; include the subject in the question, as in “Give me an example of the dot product.” Tests assert the actual model input for both streaming and non-streaming Q&A.

## Selecting information for Q&A

Q&A retrieves information through tools as needed, then composes an answer. This is a [ReAct-style tool loop (Yao et al., 2023)](../reference/ai-references.md#react), implemented with LangChain's `createAgent`. Different questions do not necessarily use the same search.

| Example question | Primary information source |
|---|---|
| “How many videos are in this course?” | Registered course and video metadata |
| “Summarize this lesson.” | Relevant subtitle scenes |
| “Show me this video's description.” | The saved description |

The core retrieval tools are:

- `get_course_info`: Course name, description, video list, and related metadata. Up to 20 videos per page and 5 calls per answer.
- `search_scenes`: Semantic subtitle search across a course or a specified video within it. Up to 3 calls per answer.

The agent can also use `read_video_window`, `overview_video`, and `skim_video`; when visuals are enabled, `inspect_clip` and `focus_clip` are available too. See [video navigation and visual evidence](../guides/visual-evidence.md) for their individual and shared budgets and [VideoSeek's role in their design](../reference/ai-references.md#videoseek).

The model can make up to `MAX_TOOL_ROUNDS = 19` tool-enabled turns, after which tools are removed and it generates a final answer. Individual tool limits can be reached sooner. The API validates arguments and access scope rather than executing model requests unchecked.

For course Q&A, the streaming API sends search progress immediately, then streams answer text and validated citations while the model generates them. The API validates the complete answer before saving it and emitting `done`. Tool-call preambles are not sent as answers. Client cancellation or interrupted delivery cancels outstanding model and embedding requests.

Scene search opens its DB connection and embedding adapter only when `search_scenes` is called. A metadata-only answer therefore does not depend on scene embeddings; it still needs course access checks, metadata reads, and answer persistence.

## Model settings and limits

These are application defaults, not measurements of production settings or provider limits.

| Setting | Current implementation |
|---|---|
| Answer and image model | `LLM_MODEL`, hosted profile `openai/gpt-6-luna` (same GPT-6 Luna model) |
| Answer endpoint | Chat Completions at `LLM_BASE_URL` (falls back to `OPENAI_BASE_URL`), hosted profile `https://openrouter.ai/api/v1` |
| Reasoning effort | `none` when the model is `gpt-6-luna` or `openai/gpt-6-luna`, for Chat Completions tool calling |
| Sampling and output budget | Temperature `0`; at most 1,024 output tokens per model call, including structured output |
| Request deadline | Course RAG: 2 minutes for non-streaming requests; 5 minutes for streaming requests |
| Automatic provider retries | Disabled in the API chat-model wrapper |
| Search budget | At most 3 scene searches, 20 results per search by default |
| Metadata budget | At most 5 calls, up to 20 videos per page |
| Tool-enabled model turns | At most 19, followed by a final turn without tools; individual tool budgets still apply |

Configure the shared answer and image model with the API's `LLM_MODEL`. It must support tool calling and strict JSON output, plus image input when visual Q&A is enabled. See [embeddings](../guides/embeddings.md) for the search-model configuration shared by the API and worker.

Model attribution: [GPT-6 Luna's official model documentation](../reference/ai-references.md#gpt-6-luna), or the source for the model actually configured.

## Structured answers, citations and permissions

The provider capability is documented in [OpenAI's Structured Outputs release](../reference/ai-references.md#structured-outputs). The source registry and citation validation described below are VideoQ's implementation.

The model returns native structured output: `{"segments":[{"text":"A claim.","sourceIds":[1]}]}`. It never supplies video destinations. The server adds `sources: [{id, video_id, title, start_time, end_time}]` from the current answer's scoped search. This `ChatAnswer` is the only answer representation in non-streaming responses, browser state, history and the `chat_logs.response` JSONB column. CSV exports derive plain text by concatenating segment texts without adding separators. Text includes its own spaces/newlines; the renderer adds timestamp links after each segment, in `sourceIds` order.

The configured Chat Completions endpoint/model must support **strict native `json_schema` output and strict function tools**, including their use together. Course Q&A uses LangChain `providerStrategy`; no-course Q&A passes the same JSON schema directly. Tool arguments explicitly include nullable `video_ids` and required pagination fields. Unsupported schema capability is a configuration error. There is no free-text fallback, conversion-only model call, or automatic repair/retry. Refusal, missing/blank output, truncation and schema violations fail the request. Tool-call preambles are never displayed as answers.

A request owns its source registry: positive safe integer IDs remain stable across repeated searches, even when the same scene is found again. Metadata-only answers use empty `sourceIds`. Retrieved candidates can include uncited sources; registration alone does not create a link. The model sees structured scene records with `sourceId`, text and server-provided metadata.

Unknown IDs and numeric IDs that are not positive safe integers are removed without changing text. Duplicate IDs in one segment are removed in first-occurrence order; the same ID in different segments stays at each position. IDs at a boundary inside code or TeX are removed, including expressions split across segments or left unclosed. Validation uses the concatenated text and shares delimiter rules with the renderer. Logs contain only `chat_citations_rejected` counts (`invalid_id`, `unknown_id`, `duplicate_id`, `unsafe_position`), never answer text or source metadata. Text such as `a[1]`, `[99]`, and Markdown brackets is ordinary text and is never interpreted as a citation.

Search enforces authorized course scope. ID validation proves that a source was retrieved for this answer; it does not prove that the source supports a claim. Prompt instructions also treat subtitles as reference data, but do not guarantee immunity from prompt injection or unsupported claims.

### Streaming contract {#streaming-contract}

`POST /api/chat/messages/stream` has one format. SSE `data` contains a JSON event defined in `@videoq/trpc/chat`; there is no format query or legacy event support.

| Event | Payload and behavior |
|---|---|
| `source` | `source: {id, video_id, title, start_time, end_time}`; register before referencing it |
| `text_delta` | `segmentIndex: number`, `text: string`; append literal text to that zero-based segment |
| `citation` | `segmentIndex: number`, `sourceId: number`; append one indivisible timestamp link after that segment |
| `searching`, `search_completed` | Search progress, separate from answer text |
| `done` | `chat_log_id`, `feedback`; persistence finished; feedback controls appear after the display queue drains |
| `error` | `code`, `message`; terminate and discard pending display content |

Both course and no-course Q&A stream text during generation. Model streaming uses LangChain Core's native content-block events and `ChatModelStream` assembly. No-course Q&A consumes `streamEvents().text` and awaits the assembled message; course Q&A requests the same native events with a `BaseCallbackHandler` and forwards them through LangGraph's custom writer alongside search/tool progress. Core owns text/tool-call assembly, scalar finish metadata and usage snapshots, so repeated provider `stop` notifications do not become `stopstop`. There is no application finish-reason deduplicator or message-chunk concatenation. No extra model call is added. The SDK partial JSON decoder exposes monotonically growing text fields, withholding incomplete escapes and Unicode surrogates; JSON syntax and tool arguments are never displayed. Natural-language tool preambles are not answer segments. A provider that emits structured answer text and then calls a tool fails the stream instead of saving the provisional text. Completion still requires the terminal stop status and a strict, complete answer. No-course answers have no source registry and therefore no citation links.

The remaining Chat Completions adapter is limited to boundaries not covered by the library path: local servers that require separate tool/schema decisions, the raw numeric provider cost ledger, and refusal fields currently omitted by Core's native converter. It uses the OpenAI SDK for requests and SSE parsing; LangChain owns all message conversion. The application still validates its answer schema, monotonic segment text, scoped source IDs and safe citation boundaries. These are VideoQ's output contract, rather than provider protocol handling.

Course citations can arrive before the answer finishes: a segment object must actually close on the wire, its IDs must belong to the retrieved sources, and its boundary must be outside code/TeX. Potentially incomplete delimiters wait for lookahead or final validation. Only that lookahead briefly buffers the next segment; the existing text → citations → next segment order is preserved. Source metadata is sent before any citation uses it.

The UI batches all queued content with `requestAnimationFrame`, scheduling work only when new text or citations arrive. It adds neither a fixed timer delay nor a per-character typing delay. `done` takes effect after queued content is applied. If the tab is hidden when the stream finishes, the queue is drained without waiting for a paused animation frame.

Sources and ordered content events precede `done`. The UI applies these events directly to `ChatAnswer`; streaming and history use the same renderer. TeX/code across segment boundaries is rendered together when no citation intervenes. Unexpected EOF is an error. Cancellation stops upstream work; retry and course/share changes create fresh state. Usage is released for generation failures before any answer text is produced, but retained after partial text or a persistence failure, matching the existing quota policy.

See [structured answer cutover and verification](structured-answers.md) for the one-time history migration and deployment procedure.

## When evidence or services are unavailable

| Situation | Current behavior |
|---|---|
| A scene search returns no hits | The tool reports no matching scenes. The model can try another query within its allowance |
| Three scene searches have already run | Further searches return a limit message; the model is instructed to answer from acquired evidence or explain the missing support |
| A selected video ID is outside the course | The tool rejects that search without consuming a search attempt and tells the model to use valid IDs |
| Retrieved scenes only partly answer the question | The prompt asks for a supported partial answer with an explanation of its limits |
| Database or embedding execution fails | The exception propagates; it is not presented to the model as “no evidence,” and reserved answer usage is released by the chat flow |
| The answer provider fails or times out | The request follows the error path; the chat-model wrapper does not automatically retry provider calls |
| The final model response is refused, invalid, incomplete, blank or still contains tool calls | The request fails; usage follows the policy above; an earlier preamble is never substituted as the answer |

Weak search matches can still be returned because the application currently has no minimum similarity cutoff. See [scene search](transcription-and-search.md). Prompt wording alone cannot fix missing transcript content or a mismatched embedding index.

## Answer persistence

The API saves the completed question, structured answer and retrieved context before emitting `done`. RAGAS scoring, evaluation APIs and score displays have been retired. Citation validation, chat history and user feedback remain. Previously queued `evaluate_chat_log` jobs are acknowledged without AI calls.

## Where to make changes

| Location | Role |
|---|---|
| [prompts/](https://github.com/videoq-jp/videoq/tree/main/apps/api/src/lib/prompts) | Instructions and settings |
| [rag.ts](https://github.com/videoq-jp/videoq/blob/main/apps/api/src/lib/rag.ts) | Q&A tool calls and answer generation |
| [rag-course-info.ts](https://github.com/videoq-jp/videoq/blob/main/apps/api/src/lib/rag-course-info.ts) | Registered course and video metadata |
| [answer-content-stream.ts](https://github.com/videoq-jp/videoq/blob/main/apps/api/src/lib/answer-content-stream.ts) / [chat-citations.ts](https://github.com/videoq-jp/videoq/blob/main/apps/api/src/lib/chat-citations.ts) | Incremental answer decoding and citation validation |
| [message-service.ts](https://github.com/videoq-jp/videoq/blob/main/apps/api/src/features/chat/message-service.ts) | Access, quota, SSE events, and persistence |
| [chatStreamController.ts](https://github.com/videoq-jp/videoq/blob/main/apps/web/src/lib/chatStreamController.ts) | Browser rendering queue and completion |

## What to check after a change

Test metadata-only questions, lesson-content questions, and questions requiring both, in English and Japanese. Check the selected tools and citations as well as the answer, and verify that information outside the course is not included.

`LLM_MODEL` is used for answers and generation; `EMBEDDING_MODEL` is used for search. Embeddings are fixed at 1536 dimensions, and the API and worker must also use the same model. Changing models requires regenerating existing vectors. See [embedding configuration and limitations](../guides/embeddings.md).

See [tests and verification commands](../guides/testing.md) for live-model tests and when they incur charges.
