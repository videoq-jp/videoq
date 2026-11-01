---
title: AI methods and references
description: Original papers, model documentation, and their relationship to VideoQ's implementation.
---

# AI methods and references

This page credits the research and model services used in VideoQ, with links to the corresponding implementation. It describes the checked-in code and configuration examples, verified on **2026-10-31**; deployed models can differ. The references here concern the system's methods, while timestamps in Q&A cite the user's video material.

The answer/image model settings and their reference were updated on **2026-10-14** to match the current GPT-6 Luna default.

## Which reference belongs to which part? {#method-map}

| Part of VideoQ | Method or model | Relationship to the source |
|---|---|---|
| Retrieve course evidence before answering | [RAG: Lewis et al., 2020](#rag) | Uses the retrieval-and-generation pattern; does not train the paper's RAG models |
| Select tools and act on their results | [ReAct: Yao et al., 2023](#react) | Uses a ReAct-style tool loop through LangChain |
| Transcribe uploaded audio | [Whisper: Radford et al., 2023](#whisper) | Uses a pretrained model via OpenRouter, direct OpenAI, or a local Whisper server |
| Split long subtitle ranges | [Otsu, 1979](#otsu) | Adapts the between-class variance criterion to ordered text embeddings |
| Explore a video at different time scales | [VideoSeek: Lin et al., 2026](#videoseek) | Adapts the overview / skim / focus tool design |
| Embed subtitle scenes and queries | [OpenAI embeddings](#openai-embeddings); optionally [Qwen3 Embedding](#qwen3-embedding) | Calls the configured pretrained embedding model |
| Generate answers and inspect images | [GPT-6 Luna](#gpt-6-luna); optionally [Qwen3-VL](#qwen3-vl) | Calls the configured pretrained model; local examples are optional |
| Return answer text with source IDs | [Structured Outputs](#structured-outputs) | Uses the provider's schema-constrained output capability and VideoQ's own citation validation |

## Research behind the implemented methods

### RAG — retrieval-augmented generation {#rag}

Patrick Lewis et al. **“Retrieval-Augmented Generation for Knowledge-Intensive NLP Tasks.”** *NeurIPS*, 2020. [Paper](https://arxiv.org/abs/2005.11401). BibTeX key: `lewis2020rag`.

VideoQ retrieves subtitle scenes and supplies them as evidence to an answer model. This follows the paper's retrieval-augmented generation idea. VideoQ uses independently configured embeddings, PGVector search, and a chat model; it does not reproduce the paper's jointly trained retriever/generator or RAG-Sequence/RAG-Token formulations.

Implementation: [vector-repository.ts](https://github.com/videoq-jp/videoq/blob/main/apps/api/src/repositories/vector-repository.ts), [rag.ts](https://github.com/videoq-jp/videoq/blob/main/apps/api/src/lib/rag.ts). See [transcription and scene search](../architecture/transcription-and-search.md).

### ReAct — tool selection and observation {#react}

Shunyu Yao, Jeffrey Zhao, Dian Yu, Nan Du, Izhak Shafran, Karthik Narasimhan, and Yuan Cao. **“ReAct: Synergizing Reasoning and Acting in Language Models.”** *ICLR*, 2023; preprint first posted in 2022. [Paper](https://arxiv.org/abs/2210.03629), [authors' project](https://react-lm.github.io/). BibTeX key: `yao2023react`.

VideoQ lets the model select a tool, read its result, and select another action or answer within enforced limits. It uses LangChain's `createAgent` and native function tools. This is a ReAct-style control loop, not a reproduction of the paper's prompts, training, or benchmarks. VideoQ does not require or display a textual chain-of-thought trace.

Implementation: [rag.ts](https://github.com/videoq-jp/videoq/blob/main/apps/api/src/lib/rag.ts), [prompts.json](https://github.com/videoq-jp/videoq/blob/main/apps/api/src/lib/prompts/prompts.json). See [Q&A prompts](../architecture/prompt-engineering.md) and [LangChain's agent documentation](https://docs.langchain.com/oss/javascript/langchain/agents).

### Whisper — speech recognition {#whisper}

Alec Radford, Jong Wook Kim, Tao Xu, Greg Brockman, Christine McLeavey, and Ilya Sutskever. **“Robust Speech Recognition via Large-Scale Weak Supervision.”** *ICML*, PMLR 202, pp. 28492–28518, 2023; preprint first posted in 2022. [Proceedings and publisher BibTeX](https://proceedings.mlr.press/v202/radford23a.html). BibTeX key: `radford2023whisper`.

The hosted profile sends uploaded audio to `openai/whisper-large-v3-turbo` through OpenRouter (`WHISPER_BACKEND=openrouter`). The legacy direct route uses `whisper-1` with `WHISPER_BACKEND=openai`. The local path calls a Whisper-compatible server; the weights are selected when starting that server. The README's `large-v3-turbo` example also has an [official model card](https://huggingface.co/openai/whisper-large-v3-turbo). Cite the Whisper paper for the model family and record the actual checkpoint for a local experiment. YouTube imports retrieve existing subtitles through SearchAPI and do not run VideoQ's Whisper path.

Implementation: [transcription.py](https://github.com/videoq-jp/videoq/blob/main/apps/worker/worker_python/pipeline/transcription.py). The optional inference software is [whisper.cpp](https://github.com/ggml-org/whisper.cpp).

### Otsu — a criterion adapted for subtitle splitting {#otsu}

Nobuyuki Otsu. **“A Threshold Selection Method from Gray-Level Histograms.”** *IEEE Transactions on Systems, Man, and Cybernetics*, 9(1), pp. 62–66, 1979. [DOI: 10.1109/TSMC.1979.4310076](https://doi.org/10.1109/TSMC.1979.4310076). BibTeX key: `otsu1979threshold`.

The original method selects an image-intensity threshold using between-class variance. VideoQ adapts that criterion to a time-ordered sequence of L2-normalized subtitle embeddings. For a candidate boundary, it maximizes `n0 * n1 * ||mean0 - mean1||²`, where `n0` and `n1` are the numbers of cues on each side and `mean0` and `mean1` are their mean vectors. For a fixed range this is proportional to the weighted between-class variance; the code uses an equivalent cumulative-sum form.

Long ranges are split repeatedly to fit a default 512-token budget. This is VideoQ's adaptation, not an Otsu paper about semantic text segmentation or visual shot detection. A single overlong cue is split by tokens with estimated timings instead.

Implementation: [SceneSplitter](https://github.com/videoq-jp/videoq/blob/main/apps/worker/worker_python/pipeline/scene_otsu/splitter.py). See [scene grouping and fallback behavior](../architecture/transcription-and-search.md).

### VideoSeek — navigation at multiple time scales {#videoseek}

Jingyang Lin, Jialian Wu, Jiang Liu, Ximeng Sun, Ze Wang, Xiaodong Yu, Jiebo Luo, Zicheng Liu, and Emad Barsoum. **“VideoSeek: Long-Horizon Video Agent with Tool-Guided Seeking.”** 2026, arXiv:2603.20185; accepted at CVPR 2026. [Paper](https://arxiv.org/abs/2603.20185), [authors' implementation and citation](https://github.com/jylins/videoseek). BibTeX key: `lin2026videoseek` (preprint citation, following the authors' repository).

VideoQ's `overview_video`, `skim_video`, and `focus_clip` take inspiration from VideoSeek's overview / skim / focus tools. VideoQ implements its own subtitle sampling, cached-frame reads, course permissions, budgets, and timestamp citations. The agent chooses the tools it needs; no fixed three-step sequence is required. This adaptation does not establish that VideoSeek's benchmark accuracy or frame savings transfer to VideoQ.

Implementation: [rag-video-evidence.ts](https://github.com/videoq-jp/videoq/blob/main/apps/api/src/lib/rag-video-evidence.ts), [visual-inspection.ts](https://github.com/videoq-jp/videoq/blob/main/apps/api/src/lib/visual-inspection.ts). See [visual evidence and sampling limits](../guides/visual-evidence.md).

## Model and API references

### OpenAI text embeddings — default {#openai-embeddings}

OpenAI. **“New embedding models and API updates.”** January 25, 2024. [Official release](https://openai.com/index/new-embedding-models-and-api-updates/). BibTeX key: `openai2024embeddings`.

The checked-in default is `text-embedding-3-small`, with 1536-dimensional outputs for both indexing and queries. Cite this model-specific official source. This entry is a product release, not a research paper. A citation to a different embedding model would not identify the model used here.

Implementation: [API embeddings](https://github.com/videoq-jp/videoq/blob/main/apps/api/src/lib/embeddings.ts), [worker embeddings](https://github.com/videoq-jp/videoq/blob/main/apps/worker/worker_python/pipeline/embeddings.py). See [embedding configuration](../guides/embeddings.md).

### GPT-6 Luna — default answer and image model {#gpt-6-luna}

OpenAI. **“GPT-6 Luna.”** [Official model documentation](https://developers.openai.com/api/docs/models/gpt-6-luna), accessed October 14, 2026; no publication date is specified. BibTeX key: `openaiGpt6Luna`.

Answer generation and image inspection share `LLM_MODEL`, which defaults to `gpt-6-luna`; the development and production Wrangler configuration set `openai/gpt-6-luna` for OpenRouter. When visual Q&A is enabled, the model must support image input, tool calling, and strict JSON output. VideoQ sets `reasoning_effort=none` for GPT-6 Luna answer and image calls; the official documentation requires this setting for tool calling through Chat Completions. Record any model override or snapshot separately; the repository default does not prove which model a deployed service used.

Implementation: [openai.ts](https://github.com/videoq-jp/videoq/blob/main/apps/api/src/lib/openai.ts), [chat-model.ts](https://github.com/videoq-jp/videoq/blob/main/apps/api/src/lib/chat-model.ts), [visual-inspection.ts](https://github.com/videoq-jp/videoq/blob/main/apps/api/src/lib/visual-inspection.ts), [wrangler.jsonc](https://github.com/videoq-jp/videoq/blob/main/apps/api/wrangler.jsonc).

### GPT-4o mini — historical evaluations {#gpt-4o-mini}

OpenAI. **“GPT-4o mini: advancing cost-efficient intelligence.”** July 18, 2024. [Official release](https://openai.com/index/gpt-4o-mini-advancing-cost-efficient-intelligence/). BibTeX key: `openai2024gpt4omini`.

Earlier evaluations, including the [structured-answer comparison](../architecture/structured-answers.md), used `gpt-4o-mini`. Keep that model attribution when citing those results; they do not measure the current GPT-6 Luna default.

### Structured Outputs — schema-constrained responses {#structured-outputs}

OpenAI. **“Introducing Structured Outputs in the API.”** August 6, 2024. [Official release](https://openai.com/index/introducing-structured-outputs-in-the-api/). BibTeX key: `openai2024structuredoutputs`.

VideoQ requests a strict JSON schema for answer segments and source IDs. The provider supplies schema-constrained generation; VideoQ supplies the source registry and validates IDs and citation placement. Schema conformance alone does not verify that a claim is supported. This is an API feature reference, not a paper establishing VideoQ's answer quality.

Implementation: [structured-answer.ts](https://github.com/videoq-jp/videoq/blob/main/apps/api/src/lib/structured-answer.ts). See [structured answers](../architecture/structured-answers.md).

### Qwen3 Embedding — optional local configuration {#qwen3-embedding}

Yanzhao Zhang et al. **“Qwen3 Embedding: Advancing Text Embedding and Reranking Through Foundation Models.”** 2025, arXiv:2506.05176. [Technical report](https://arxiv.org/abs/2506.05176). BibTeX key: `zhang2025qwen3embedding`.

The [local inference guide](../guides/local-inference.md) uses Qwen3-Embedding-4B through a private vLLM endpoint. Cite this report only when that model family is used, and record the actual model tag and digest. The report covers rerankers too; VideoQ currently uses embeddings without a second reranking model.

### Qwen3-VL — optional local configuration {#qwen3-vl}

Shuai Bai et al. **“Qwen3-VL Technical Report.”** 2025, arXiv:2511.21631. [Technical report](https://arxiv.org/abs/2511.21631), [authors' model repository](https://github.com/QwenLM/Qwen3-VL). BibTeX key: `bai2025qwen3vl`.

This vision-model family is an option for a separately validated [local configuration](https://github.com/videoq-jp/videoq#optional-reduce-costs-with-local-ai). It is not the default model. Cite the report when using that family and record the exact weights/quantization. VideoQ's endpoint requirements still apply: strict structured output and tool calling, plus image input for visual inspection. The citation is not a compatibility test.

## Reuse the citations {#reuse}

All eleven entries above are available in [ai-references.bib](https://github.com/videoq-jp/videoq/blob/main/docs/reference/ai-references.bib). The BibTeX file distinguishes conference/journal papers, technical-report preprints, and official web publications. Select the entries for the methods and models actually used in your experiment.

For a methods section using the defaults, a suitable starting point is:

> VideoQ transcribes uploaded audio with Whisper (Radford et al., 2023), applies an Otsu-inspired variance criterion to segment subtitle embeddings (Otsu, 1979), and retrieves course evidence for answer generation using the RAG pattern (Lewis et al., 2020). A ReAct-style tool loop (Yao et al., 2023) can navigate video evidence using tools inspired by VideoSeek (Lin et al., 2026). Embeddings use OpenAI's text-embedding-3-small (OpenAI, 2024), and answer/image generation uses GPT-6 Luna (OpenAI, n.d.).

Adjust that description for subtitle imports, disabled visuals, or model overrides. For reproducibility, record the VideoQ commit, model identifiers and provider, local weight digests/quantization if applicable, embedding dimensions, tool/frame budgets, prompts, and evaluation date. Cite the separate OpenAI entries for embeddings and GPT-6 Luna, including the access date for the undated model documentation. Research citations credit the methods; they do not substitute for an evaluation of VideoQ.
