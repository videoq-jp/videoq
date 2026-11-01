---
title: AIの手法と参考文献
description: VideoQで使う手法の原論文、モデルの公式資料、実装との対応関係。
---

# AIの手法と参考文献

VideoQで使う研究手法とモデルサービスの出典を、対応する実装とともに示します。**2026-10-31**にリポジトリのコードと設定例を確認しました。実際の稼働環境ではモデルを変更できます。このページはシステムの手法に関する参考文献です。Q&Aの時刻リンクは、利用者の動画内の根拠を引用します。

回答・画像モデルの設定と出典は、**2026-10-14**に現在の既定値であるGPT-6 Lunaへ更新しました。

## どの処理にどの文献を引用するか {#method-map}

| VideoQの処理 | 手法・モデル | 出典との関係 |
|---|---|---|
| 講座の根拠を検索して回答する | [RAG: Lewis et al., 2020](#rag) | 検索と生成を組み合わせる構成を採用。論文のRAGモデルの学習は行わない |
| ツールを選び、結果を見て次の行動を決める | [ReAct: Yao et al., 2023](#react) | LangChainを通じてReAct型のツールループを利用 |
| アップロード音声を文字起こしする | [Whisper: Radford et al., 2023](#whisper) | OpenRouter、直接接続のOpenAI、またはローカルのWhisperサーバーで学習済みモデルを利用 |
| 長い字幕区間を分割する | [大津法: Otsu, 1979](#otsu) | クラス間分散の基準を時系列の文章埋め込みへ応用 |
| 動画を異なる時間範囲で調べる | [VideoSeek: Lin et al., 2026](#videoseek) | overview / skim / focusのツール設計を参考に実装 |
| 字幕と検索文を埋め込みにする | [OpenAIの埋め込み](#openai-embeddings)、任意で[Qwen3 Embedding](#qwen3-embedding) | 設定された学習済み埋め込みモデルを呼び出す |
| 回答を生成し、画像を確認する | [GPT-6 Luna](#gpt-6-luna)、任意で[Qwen3-VL](#qwen3-vl) | 設定された学習済みモデルを呼び出す。ローカル構成は任意 |
| 回答本文と出典IDを構造化して返す | [Structured Outputs](#structured-outputs) | 提供元のスキーマ制約付き出力と、VideoQ独自の引用検証を利用 |

## 実装した手法の研究上の出典

### RAG — 検索拡張生成 {#rag}

Patrick Lewis et al. **“Retrieval-Augmented Generation for Knowledge-Intensive NLP Tasks.”** *NeurIPS*, 2020。[論文](https://arxiv.org/abs/2005.11401)。BibTeXキー: `lewis2020rag`。

VideoQは字幕の場面を検索し、回答モデルへ根拠として渡します。この構成は論文の検索拡張生成の考え方に対応します。実装では埋め込み、PGVector検索、チャットモデルをそれぞれ設定します。論文の検索器と生成器の共同学習や、RAG-Sequence / RAG-Tokenを再現するものではありません。

対応実装: [vector-repository.ts](https://github.com/videoq-jp/videoq/blob/main/apps/api/src/repositories/vector-repository.ts)、[rag.ts](https://github.com/videoq-jp/videoq/blob/main/apps/api/src/lib/rag.ts)。[文字起こしとシーン検索](../architecture/transcription-and-search.md)も参照してください。

### ReAct — ツールの選択と結果の観察 {#react}

Shunyu Yao, Jeffrey Zhao, Dian Yu, Nan Du, Izhak Shafran, Karthik Narasimhan, and Yuan Cao. **“ReAct: Synergizing Reasoning and Acting in Language Models.”** *ICLR*, 2023。プレプリント初公開は2022年。[論文](https://arxiv.org/abs/2210.03629)、[著者のプロジェクト](https://react-lm.github.io/)。BibTeXキー: `yao2023react`。

VideoQは、モデルがツールを選択し、実行結果を読み、制限の範囲で次の行動または回答を選ぶループを使います。実装はLangChainの `createAgent` とネイティブの関数ツールです。ReAct型の制御であり、論文のプロンプト・学習・ベンチマークの再現ではありません。文章化した思考過程の出力や表示も必須にしていません。

対応実装: [rag.ts](https://github.com/videoq-jp/videoq/blob/main/apps/api/src/lib/rag.ts)、[prompts.json](https://github.com/videoq-jp/videoq/blob/main/apps/api/src/lib/prompts/prompts.json)。[Q&Aのプロンプト](../architecture/prompt-engineering.md)、[LangChain公式のエージェント解説](https://docs.langchain.com/oss/javascript/langchain/agents)も参照してください。

### Whisper — 音声認識 {#whisper}

Alec Radford, Jong Wook Kim, Tao Xu, Greg Brockman, Christine McLeavey, and Ilya Sutskever. **“Robust Speech Recognition via Large-Scale Weak Supervision.”** *ICML*, PMLR 202, pp. 28492–28518, 2023。プレプリント初公開は2022年。[論文集と出版社のBibTeX](https://proceedings.mlr.press/v202/radford23a.html)。BibTeXキー: `radford2023whisper`。

ホスト型の構成では、アップロードした音声を OpenRouter 経由の `openai/whisper-large-v3-turbo` へ送ります（`WHISPER_BACKEND=openrouter`）。旧来の直接接続（`WHISPER_BACKEND=openai`）では `whisper-1` を使います。ローカル経路ではWhisper互換サーバーを呼び、重みはサーバー起動時に選びます。READMEの `large-v3-turbo` には[公式モデルカード](https://huggingface.co/openai/whisper-large-v3-turbo)もあります。モデル系列の出典にWhisper論文を引用し、ローカル実験では実際のチェックポイントも記録してください。YouTube登録はSearchAPIで既存字幕を取得し、VideoQのWhisper経路は使いません。

対応実装: [transcription.py](https://github.com/videoq-jp/videoq/blob/main/apps/worker/worker_python/pipeline/transcription.py)。任意のローカル推論ソフトウェアは[whisper.cpp](https://github.com/ggml-org/whisper.cpp)です。

### 大津法 — 字幕分割への基準の応用 {#otsu}

Nobuyuki Otsu. **“A Threshold Selection Method from Gray-Level Histograms.”** *IEEE Transactions on Systems, Man, and Cybernetics*, 9(1), pp. 62–66, 1979。[DOI: 10.1109/TSMC.1979.4310076](https://doi.org/10.1109/TSMC.1979.4310076)。BibTeXキー: `otsu1979threshold`。

原論文は、画像の濃淡のしきい値をクラス間分散で選ぶ手法です。VideoQはその基準を、L2正規化した字幕埋め込みの時系列へ応用しています。境界の前後の字幕数を `n0`・`n1`、平均ベクトルを `mean0`・`mean1` として、`n0 * n1 * ||mean0 - mean1||²` が最大の境界を選びます。同じ区間内では重み付きクラス間分散に比例する量で、コードは累積和を使った同値な式を計算します。

長い区間を繰り返し分け、既定で512トークン以内にします。これはVideoQによる応用であり、大津の原論文が文章の意味分割や動画のショット検出を提案したわけではありません。一つの字幕だけで上限を超える場合は、トークン単位の分割と時刻の推定を使います。

対応実装: [SceneSplitter](https://github.com/videoq-jp/videoq/blob/main/apps/worker/worker_python/pipeline/scene_otsu/splitter.py)。[場面の分割と失敗時の挙動](../architecture/transcription-and-search.md)も参照してください。

### VideoSeek — 時間範囲を変えながら動画を探索 {#videoseek}

Jingyang Lin, Jialian Wu, Jiang Liu, Ximeng Sun, Ze Wang, Xiaodong Yu, Jiebo Luo, Zicheng Liu, and Emad Barsoum. **“VideoSeek: Long-Horizon Video Agent with Tool-Guided Seeking.”** 2026, arXiv:2603.20185。CVPR 2026採択。[論文](https://arxiv.org/abs/2603.20185)、[著者の実装と引用情報](https://github.com/jylins/videoseek)。BibTeXキー: `lin2026videoseek`（著者のリポジトリに合わせてプレプリントを引用）。

VideoQの `overview_video`・`skim_video`・`focus_clip` は、VideoSeekのoverview / skim / focusツールを参考にしています。字幕の抽出、保存済み画像の読み取り、講座の権限、実行上限、時刻の引用はVideoQ独自の実装です。必要なツールをエージェントが選び、固定の3段階を必須にはしません。この応用だけで、論文の精度や処理画像数の削減効果をVideoQでも達成したとはいえません。

対応実装: [rag-video-evidence.ts](https://github.com/videoq-jp/videoq/blob/main/apps/api/src/lib/rag-video-evidence.ts)、[visual-inspection.ts](https://github.com/videoq-jp/videoq/blob/main/apps/api/src/lib/visual-inspection.ts)。[映像確認とサンプリングの制限](../guides/visual-evidence.md)も参照してください。

## モデルとAPIの出典

### OpenAIの文章埋め込み — 既定の構成 {#openai-embeddings}

OpenAI. **“New embedding models and API updates.”** 2024年1月25日。[公式発表](https://openai.com/index/new-embedding-models-and-api-updates/)。BibTeXキー: `openai2024embeddings`。

リポジトリの既定値は `text-embedding-3-small` で、索引作成と検索の両方に1536次元の出力を使います。このモデルを特定する公式資料を引用します。資料の種別は製品発表であり、研究論文ではありません。別の埋め込みモデルの論文では、このモデルを使ったことの出典にはなりません。

対応実装: [APIの埋め込み](https://github.com/videoq-jp/videoq/blob/main/apps/api/src/lib/embeddings.ts)、[workerの埋め込み](https://github.com/videoq-jp/videoq/blob/main/apps/worker/worker_python/pipeline/embeddings.py)。[埋め込みの設定](../guides/embeddings.md)も参照してください。

### GPT-6 Luna — 既定の回答・画像モデル {#gpt-6-luna}

OpenAI. **“GPT-6 Luna.”** [公式モデル資料](https://developers.openai.com/api/docs/models/gpt-6-luna)、2026年10月14日参照。公開日は記載されていません。BibTeXキー: `openaiGpt6Luna`。

回答生成と画像確認は共通の `LLM_MODEL` を使います。既定値は `gpt-6-luna` で、開発用と本番用のWrangler設定ではOpenRouter向けに `openai/gpt-6-luna` を指定しています。映像確認を有効にする場合は、画像入力・ツール呼び出し・厳密なJSON出力に対応したモデルが必要です。VideoQはGPT-6 Lunaの回答・画像リクエストに `reasoning_effort=none` を指定します。公式資料では、Chat Completionsでツールを呼び出す際にこの設定が必要です。モデルの変更やスナップショットの指定は別途記録してください。リポジトリの既定値だけでは、本番で使ったモデルは特定できません。

対応実装: [openai.ts](https://github.com/videoq-jp/videoq/blob/main/apps/api/src/lib/openai.ts)、[chat-model.ts](https://github.com/videoq-jp/videoq/blob/main/apps/api/src/lib/chat-model.ts)、[visual-inspection.ts](https://github.com/videoq-jp/videoq/blob/main/apps/api/src/lib/visual-inspection.ts)、[wrangler.jsonc](https://github.com/videoq-jp/videoq/blob/main/apps/api/wrangler.jsonc)。

### GPT-4o mini — 過去の検証で使用したモデル {#gpt-4o-mini}

OpenAI. **“GPT-4o mini: advancing cost-efficient intelligence.”** 2024年7月18日。[公式発表](https://openai.com/index/gpt-4o-mini-advancing-cost-efficient-intelligence/)。BibTeXキー: `openai2024gpt4omini`。

[構造化回答の比較](../architecture/structured-answers.md)など、過去の検証では `gpt-4o-mini` を使用しました。これらの結果を引用する際は、実際に使ったモデル名を残してください。現在の既定値であるGPT-6 Lunaの測定結果ではありません。

### Structured Outputs — スキーマに従う出力 {#structured-outputs}

OpenAI. **“Introducing Structured Outputs in the API.”** 2024年8月6日。[公式発表](https://openai.com/index/introducing-structured-outputs-in-the-api/)。BibTeXキー: `openai2024structuredoutputs`。

VideoQは回答の文章区間と出典IDにstrictなJSONスキーマを指定します。スキーマに従う生成は提供元の機能で、出典の管理、ID検証、引用位置の検証はVideoQの処理です。形式が正しくても、主張を根拠が裏付けることまでは検証できません。これはAPI機能の出典であり、VideoQの回答品質を示す論文ではありません。

対応実装: [structured-answer.ts](https://github.com/videoq-jp/videoq/blob/main/apps/api/src/lib/structured-answer.ts)。[構造化回答](../architecture/structured-answers.md)も参照してください。

### Qwen3 Embedding — 任意のローカル構成 {#qwen3-embedding}

Yanzhao Zhang et al. **“Qwen3 Embedding: Advancing Text Embedding and Reranking Through Foundation Models.”** 2025, arXiv:2506.05176。[技術報告](https://arxiv.org/abs/2506.05176)。BibTeXキー: `zhang2025qwen3embedding`。

[ローカル AI 推論ガイド](../guides/local-inference.md)では、社内 vLLM 経由の Qwen3-Embedding-4B を構成例として示しています。この系列を実際に使う場合に引用し、モデルのタグとダイジェストも記録します。報告はリランカーも扱いますが、VideoQは埋め込みを利用し、二段目の再ランキングモデルは使っていません。

### Qwen3-VL — 任意のローカル構成 {#qwen3-vl}

Shuai Bai et al. **“Qwen3-VL Technical Report.”** 2025, arXiv:2511.21631。[技術報告](https://arxiv.org/abs/2511.21631)、[著者のモデルリポジトリ](https://github.com/QwenLM/Qwen3-VL)。BibTeXキー: `bai2025qwen3vl`。

Qwen3-VL は、別途検証したローカル構成で選べる視覚モデルの系列です。既定のモデルではありません。この系列を使う場合に引用し、重みと量子化の条件も記録します。VideoQ側の要件であるstrictな構造化出力とツール呼び出し、映像確認時の画像入力への対応は別途必要です。文献の引用は互換性の動作確認を意味しません。

## 引用を再利用する {#reuse}

上記11件を [ai-references.bib](https://github.com/videoq-jp/videoq/blob/main/docs/reference/ai-references.bib) にまとめています。学会・学術誌の論文、技術報告のプレプリント、公式Web資料を区別して登録しています。実験で実際に使った手法・モデルの項目を選んでください。

既定の構成を方法節で説明する場合の例です。

> VideoQは、アップロード音声をWhisper（Radford et al., 2023）で文字起こしし、大津法の分散基準を応用して字幕埋め込みを分割する（Otsu, 1979）。講座の根拠を検索して回答を生成するRAG構成（Lewis et al., 2020）と、ReAct型のツールループ（Yao et al., 2023）を用いる。動画の根拠探索にはVideoSeek（Lin et al., 2026）を参考にしたツールを利用する。埋め込みにはOpenAIのtext-embedding-3-small（OpenAI, 2024）、回答・画像の推論にはGPT-6 Luna（OpenAI, n.d.）を用いる。

字幕の取り込み、映像確認の無効化、モデル変更などに合わせて記述を調整してください。再現性のため、VideoQのコミット、モデル識別子と提供元、該当する場合はローカル重みのダイジェスト・量子化、埋め込み次元、ツール・画像数の上限、プロンプト、評価日を記録します。OpenAIの埋め込みとGPT-6 Lunaはそれぞれの項目を引用し、公開日が記載されていないモデル資料には参照日も付けてください（n.d.は日付不明を表します）。研究の引用による出典表示と、VideoQ自体の評価結果は別のものです。
