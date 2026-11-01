---
sidebar_label: ローカル AI 推論
description: LLM・埋め込み生成・Whisper をオンプレのネットワーク内で動かす。
---

# AI 処理もオンプレで完結させる

Web・API・ワーカーに加えて、LLM・埋め込み生成・Whisper も社内に配置できます。
導入時はコンテナイメージとモデルをダウンロードし、運用中の動画・音声・AI リクエストは
社内のサービスで処理します。アプリ用 Helm Chart の標準設定はホスト型の OpenRouter のため、
ローカル用の設定を明示的に適用します。

| 構成 | LLM・埋め込み生成 | アプリ側の設定 |
|---|---|---|
| 推奨：NVIDIA + CPU | gpt-oss-20b を vLLM、EmbeddingGemma 2 を CPU で実行 | `local-ai-gpt-oss.yaml` |
| CPU | llama.cpp。回答用・埋め込み用を別サービスに配置 | `local-ai-llamacpp.yaml` |
| NVIDIA GPU | vLLM CUDA。回答用・埋め込み用を別サービスに配置 | `local-ai-vllm.yaml` |
| AMD GPU | vLLM ROCm。実機での受け入れ検証が必要 | `local-ai-vllm.yaml` |

推奨するモデルは **gpt-oss-20b + EmbeddingGemma 2 + Whisper large-v3-turbo** です。
推論側の `charts/videoq-inference/examples/gpt-oss-embeddinggemma.yaml` と、
アプリ側の `charts/videoq/examples/local-ai-gpt-oss.yaml` を組み合わせます。
LLM に NVIDIA GPU を1台割り当て、埋め込みと whisper.cpp は CPU で動かします。
従来の Qwen 構成も互換性確認用に残しています。小さい CPU 専用 VPS では、
LLM の接続先を別の社内 GPU サーバーに設定してください。

EmbeddingGemma 2 は270Mのテキスト用部分だけを読み込みます。質問には `SearchQuery`、
字幕には `Document` のプロンプトを適用し、正規化した768次元を返します。
`ai.embeddingProfile: embeddinggemma2` を API・ワーカーの両方に適用します。
専用 API は OpenAI 互換の入力に加え、`input_type: query|document` を受け付けます。
未知のモデル、異なる次元数、長すぎる入力は受け付けません。

新しいアプリを起動する前に DB マイグレーションを適用します。768次元用の
`scene_embeddings_768` テーブルを追加し、従来の1536次元データは変更しません。
アップロードと字幕編集を停止したメンテナンス時間に、新しい設定のワーカーで再生成します。

```sh
kubectl -n videoq exec deployment/videoq-worker -- python -c \
  'from worker_python.tasks.reindexing import reindex_all_videos_embeddings; reindex_all_videos_embeddings()'
```

完了まで検索を公開しないでください。新しい構成には従来の
`PGVECTOR_COLLECTION_NAME=scene_embeddings` を設定しません。設定を戻すと旧テーブルを
参照しますが、切り替え後に追加・編集した動画は旧構成でも再生成が必要です。
異なるモデルのベクトルを混ぜたり、切り詰め・ゼロ埋めで次元を合わせることはしません。

gpt-oss は `reasoningEffort: low`、OpenAI 用のツール・推論パーサーを使います。
`preserveToolReasoning: true` でツール呼び出し後の推論情報を内部的に引き継ぎ、回答文には
混ぜません。gpt-oss はテキスト専用のため視覚解析は無効です。EmbeddingGemma 2 も画像・音声の
エンコーダーは読み込みません。映像を直接検索するには別途インデックス処理の実装が必要です。
`separateToolSchema: true` で、検索ツールを選ぶ処理と最終回答の JSON 形式の強制を分けます。
検索を最終回答用の制約で抑制しないための互換設定です。

CPU 推論イメージには、新しい `embedding_server.py` とロック済み依存関係が必要です。
旧 Whisper 専用イメージでは動作しません。ソースからのビルドと導入は
[推論用 Chart の推奨構成](https://github.com/videoq-jp/videoq/blob/main/charts/videoq-inference/README.md#recommended-gpt-oss--embeddinggemma-2--whisper-profile)
を参照してください。

文字起こしは **CPU で whisper.cpp、NVIDIA／AMD GPU で vLLM** を使います。
どちらも社内の共通 API を経由し、VAD と音量補正の後に認識し、字幕時刻を元の動画へ戻します。
Mac の手元開発では、Metal を使うネイティブの whisper.cpp も利用できます。
アプリの設定名は `WHISPER_BACKEND=local` に統一し、`WHISPER_LOCAL_URL` で接続先を指定します。

従来の `vllm-nvidia.yaml` の API は音声2件までを受け付け、各音声から最大4区間を並行して vLLM に送信します。
vLLM は最大8区間を動的にまとめて推論します。動画が8件たまるのを待つ方式ではありません。
CPU は音声1件ずつ処理し、ワーカーの永続チェックポイントは30秒、GPU は300秒です。
`ai.whisperChunkSeconds` で30〜300秒に調整できます。CPU の標準モデルは多言語の
量子化 large-v3-turbo（Q5_0）です。速度と日本語の認識品質は、導入先の機器・録画で確認してください。

CPU の推論エンジンは2コアを予約します。API は音声1件の全区間を合わせて600秒、
ワーカーは660秒まで待ちます。GPU の設定では API 側を110秒にします。
`whisper.requestTimeoutSeconds` は1〜600秒で指定でき、区間ごとに期限を延長することはありません。

API の形式は OpenAI 互換に統一し、`EMBEDDING_BASE_URL` で社内の埋め込み API を指定します。LLM の `OPENAI_BASE_URL` とは
独立して設定します。認証も分ける場合は Secret に `EMBEDDING_API_KEY` を設定します。

具体的なコマンドは、[推論用 Chart の導入手順](https://github.com/videoq-jp/videoq/blob/main/charts/videoq-inference/README.md)
にあります。署名付きイメージと推論用 Chart の導入、CPU・NVIDIA／AMD GPU の設定、モデルの永続化、
導入後のダウンロード停止、通信制限、実モデルの確認手順をまとめています。
アプリ側は `charts/videoq/examples/` の対応する設定を重ね、更新時も同じ設定を維持します。

CPU の基本構成では、テキスト専用モデルを使うため映像の視覚解析を無効にします。
文字起こし・字幕検索・引用付き回答・タイムスタンプ再生は利用できます。
視覚解析も社内で使うには、画像入力・ツール呼び出し・JSON Schema 出力に対応した
ローカルモデルを別途検証します。vLLM の基本設定例は、LLM・埋め込み・Whisper に
1 GPU ずつ、合計3 GPU を割り当てます。LLM・埋め込みを CPU のまま使う場合は、
`whisper-nvidia.yaml` を重ねて文字起こしだけに GPU を割り当てられます。vLLM の GPU 実行・ドライバー互換性は実機での検証が必要です。
日本語の認識・回答品質と処理能力も導入先で確認します。

[署名付き Public 配布](on-premises-releases.md)に文字起こしゲートウェイと推論用 Chart を含めます。
上流の CUDA／ROCm vLLM イメージは Chart で digest を固定して直接使用します。
検証スクリプトが推論用の `verified-inference.json` とアプリ用の `verified-images.json` を生成します。
導入先での Whisper ビルドは不要です。外部の AI サービス（OpenRouter・OpenAI）の API キーは不要で、SDK 向けの仮の値として
`OPENAI_API_KEY=local-inference` を設定します。その他の Secret は
[アプリの導入手順](on-premises.md)に従います。

導入後は、社外への通信を止めた状態で、アップロード → 文字起こし → インデックス登録 →
引用付きストリーミング回答 → タイムスタンプ再生を確認します。通信制限には NetworkPolicy を
実際に適用する CNI が必要です。埋め込みのモデル・量子化・pooling・前処理を切り替えると、同じ 1536 次元でも既存動画の
埋め込み再生成が必要です。llama.cpp の CPU 構成は元の出力が 1536 次元の gte-Qwen2、
vLLM は Qwen3-Embedding-4B の Matryoshka 出力を 1536 次元に指定します。
オンプレ版では外部メール・Google ログイン・Stripe・YouTube/SearchAPI を無効にし、
管理者がローカルアカウントと初期設定リンクを発行します。

## 役割ごとの選択と既存サービスの利用

推論用 Chart は `servers.chat.enabled`・`servers.embedding.enabled`・`whisper.enabled` で
必要なサービスだけを配置できます。無効にした役割は Deployment・Service・キャッシュ用 PVC を
新規作成しません。既存 PVC は保持し、アプリの接続先は別途明示的に設定します。
回答用と埋め込み用は各 `backend`（`llamacpp`／`vllm`）と `accelerator`（`nvidia`／`amd`）を
個別に選択できます。空の設定は Chart 全体の既定値を継承します。
文字起こしにも独立した `backend`・`accelerator` があります。

Linux arm64 CPU 用は `cpu-arm64.yaml`、文字起こしだけの配置は `speech-only-cpu.yaml`、
異なる実行エンジン・GPU の混在例は `mixed-engines.yaml` です。
モデル形式と GPU リソース指定も各役割に合わせ、複数の全 GPU プロファイルは重ねないでください。
[環境・役割の対応表](https://github.com/videoq-jp/videoq/blob/main/charts/videoq-inference/README.md#select-roles-and-environments)を参照してください。

既存の OpenAI 互換文字起こし API には `WHISPER_BACKEND=local` と
`WHISPER_LOCAL_URL`・`WHISPER_LOCAL_MODEL`、必要に応じて `WHISPER_LOCAL_API_KEY` を設定します。
アプリ用 Chart では URL・モデル名を `ai.whisperLocalUrl`・`ai.whisperLocalModel`、
認証キーを既存の Secret に設定します。VideoQ のゲートウェイは従来どおり
`whisper-local` を使います。専用キーがなければ従来の `OPENAI_API_KEY` を再利用します。
Lambda の app SSM SecureString にも各役割の URL・モデル名・認証キーを保存でき、環境変数を優先します。

API の形式だけでなく、チャットのツール呼び出し・JSON Schema、同じモデルによる 1536 次元の
検索／登録ベクトル、実際の字幕時刻を含む `verbose_json` の返却を検証してください。
接続失敗時に別のクラウドプロバイダーへ自動切り替えはしません。
上流イメージが必要な音声デコーダーを提供する場合は、検証後に `whisper.audioCodecs: upstream` で
一時的なコーデック配置を無効化できます。

## AMD GPU の構成

Linux／Kubernetes 向けに `charts/videoq-inference/examples/vllm-amd.yaml` を用意しています。
`vllm.accelerator: amd` で上流の `vllm/vllm-openai-rocm` を digest 固定で直接使い、
LLM・埋め込み・文字起こしに `amd.com/gpu: 1` をそれぞれ割り当てます。
アプリ側は `charts/videoq/examples/local-ai-vllm.yaml` を使います。

文字起こしだけ AMD GPU にする場合は `whisper-amd.yaml` とアプリ側の
`local-ai-llamacpp.yaml` を使い、`ai.whisperChunkSeconds: 300` を設定します。
NVIDIA と AMD のプロファイルは重ねず、必要な方を選んでください。

固定した ROCm 版には音声デコーダーが不足するため、AMD の文字起こしだけは
ゲートウェイに固定した公開 `soundfile`／CFFI パッケージを init container で
共有領域へコピーし、推論側で読み取り専用に使用します。vLLM イメージの再ビルドや
起動時の pip／ネット接続は行いません。モデル取得を無効にした後も、このローカル配置処理は残ります。

対応する GPU・Linux ドライバーと AMD device plugin／GPU Operator が必要です。
非 root の GPU アクセスに必要な場合は `vllm.supplementalGroups` に各ノードの実際の
render／video グループ ID を設定します。GPU 型番は未定で、AMD 実機での検証は未実施です。

[導入・実機検証手順](https://github.com/videoq-jp/videoq/blob/main/charts/videoq-inference/README.md#amd-rocm-deployment)に沿って、
`apps/inference/vllm/check_gpu_runtime.py` で ROCm・GPU 割り当て・FP16 演算を確認し、
ツール呼び出し・JSON Schema・1536 次元の埋め込み・日本語文字起こしと字幕時刻・
動画アップロードから引用付き回答までを対象の機種で検証してください。
CI の WAV デコード検証と脆弱性スキャンは、GPU 推論の検証結果ではありません。

## Mac で llama.cpp を使う

[Homebrew の llama.cpp パッケージ](https://formulae.brew.sh/formula/llama.cpp)には
`llama-server` が含まれます。Apple Silicon の Metal を使う場合は macOS 上で
直接起動します。Linux／Kubernetes の CPU 構成（`--gpu-layers 0`）とは別の手順です。

推論用 Chart と同じ GGUF モデルを、固定した版とチェックサムで取得します。

```sh
brew install llama.cpp
mkdir -p .local-models/llama
curl --fail --location --output .local-models/llama/Qwen3-4B-Q4_K_M.gguf \
  https://huggingface.co/Qwen/Qwen3-4B-GGUF/resolve/bc640142c66e1fdd12af0bd68f40445458f3869b/Qwen3-4B-Q4_K_M.gguf
echo "7485fe6f11af29433bc51cab58009521f205840f5b4ae3a32fa7f92e8534fdf5  .local-models/llama/Qwen3-4B-Q4_K_M.gguf" | shasum -a 256 -c -
curl --fail --location --output .local-models/llama/gte-Qwen2-1.5B-instruct-Q4_K_M.gguf \
  https://huggingface.co/second-state/gte-Qwen2-1.5B-instruct-GGUF/resolve/124fbdad7d80e987f3a4d8cd201f721ca37fe9b8/gte-Qwen2-1.5B-instruct-Q4_K_M.gguf
echo "a40df5cabb8c70f2fa144bc6a8674c2c987bfe3b4571134c767832aae1d246b9  .local-models/llama/gte-Qwen2-1.5B-instruct-Q4_K_M.gguf" | shasum -a 256 -c -
```

以下をそれぞれ別のターミナルで起動します。`--gpu-layers 99` は GPU への配置を要求します。
起動ログで Metal デバイスと実際の配置レイヤーを確認してください。
回答用・埋め込み用の両プロセスが Mac のユニファイドメモリを共有します。

```sh
# Terminal 1: chat
llama-server --model .local-models/llama/Qwen3-4B-Q4_K_M.gguf \
  --alias videoq-chat --host 127.0.0.1 --port 8000 \
  --ctx-size 8192 --parallel 1 --gpu-layers 99 --offline \
  --jinja --reasoning off

# Terminal 2: embeddings (native 1536 dimensions)
llama-server --model .local-models/llama/gte-Qwen2-1.5B-instruct-Q4_K_M.gguf \
  --alias gte-qwen2-1.5b-q4km-124fbdad --host 127.0.0.1 --port 8001 \
  --ctx-size 8192 --parallel 1 --gpu-layers 99 --offline \
  --embedding --pooling last
```

API とワーカーを Docker Desktop で起動する場合は、両方に次の環境変数を設定します。
Compose では `.env` を使い、API に別のローカル変数ファイルを使う場合も同じ値に揃えます。

```dotenv
OPENAI_BASE_URL=http://host.docker.internal:8000/v1
OPENAI_API_KEY=local-inference
LLM_MODEL=videoq-chat
LLM_REASONING_EFFORT=none
LLM_SEPARATE_TOOL_SCHEMA=true
LLM_REQUEST_TIMEOUT_MS=600000
LLM_STREAM_TIMEOUT_MS=600000
EMBEDDING_BASE_URL=http://host.docker.internal:8001/v1
EMBEDDING_API_KEY=local-inference
EMBEDDING_MODEL=gte-qwen2-1.5b-q4km-124fbdad
VIDEO_VISUAL_ENABLED=false
```

Mac 上で直接動かすプロセスでは `host.docker.internal` を `127.0.0.1` に置き換えます。
サーバーはループバックで待ち受け、API とワーカーで埋め込みモデル・エイリアス・接続先を
揃えてください。埋め込みモデルの切り替え時は既存シーンの再インデックスが必要です。
文字起こしは別設定なので、次節も参照してください。

これは Mac 向けの設定手順であり、Mac／Metal の実機検証結果ではありません。
Homebrew の版は Linux の固定イメージと異なる場合があるため、導入した版でツール呼び出し・
JSON Schema・1536 次元の埋め込み・VideoQ の動画処理から回答までを確認してください。

## Mac で whisper.cpp を使う

Apple Silicon の Metal を使うため、whisper.cpp は macOS 上で直接起動します。
Kubernetes では CPU に whisper.cpp、NVIDIA／AMD に vLLM を配置し、共通 API を経由します。

[Homebrew の whisper.cpp パッケージ](https://formulae.brew.sh/formula/whisper.cpp)
と FFmpeg を導入し、VideoQ のルートで実行します。対応する bottle には
`whisper-server` が含まれるため、手元でのビルドは不要です。

```sh
brew update
brew install whisper.cpp ffmpeg
mkdir -p .local-models/whisper
curl --fail --location --output .local-models/whisper/ggml-large-v3-turbo-q5_0.bin \
  https://huggingface.co/ggerganov/whisper.cpp/resolve/5359861c739e955e79d9a303bcbc70fb988958b1/ggml-large-v3-turbo-q5_0.bin
echo "394221709cd5ad1f40c46e6031ca61bce88931e6e088c188294c6d5a55ffa7e2  .local-models/whisper/ggml-large-v3-turbo-q5_0.bin" | shasum -a 256 -c -
whisper-server -m .local-models/whisper/ggml-large-v3-turbo-q5_0.bin \
  --host 127.0.0.1 --port 8080 --inference-path /audio/transcriptions \
  --convert -l auto
```

確認した Homebrew パッケージは whisper.cpp 1.9.5 です。モデルの版とチェックサムは
上記で固定し、導入時に取得して起動後はローカルのファイルを読み込みます。
オプションの Git サブモジュールは、ソース検証や適切なパッケージがない環境向けに残します。ワーカーは MP3 を送るため、Mac 側の
FFmpeg で変換する `--convert` が必要です。タイムスタンプは有効にしたまま使います。
ワーカーが `verbose_json` とセグメント単位の時刻を要求します。日本語に固定する場合は
`-l auto` を `-l ja` に変更します。リクエストのモデル名 `whisper-local` は共通の呼び出し名で、
whisper.cpp が実際に使う重みは `-m` で指定したファイルです。

ワーカーには、文字起こしのパスを含めず、API のベース URL を設定します。

| 文字起こしサービス | `WHISPER_BACKEND` | `WHISPER_LOCAL_URL` |
|---|---|---|
| Mac の whisper.cpp、ワーカーも Mac 上で直接実行 | `local` | `http://127.0.0.1:8080` |
| Mac の whisper.cpp、ワーカーは Docker Desktop | `local` | `http://host.docker.internal:8080` |
| Kubernetes の whisper.cpp / vLLM | `local` | `http://videoq-inference-whisper:8080/v1` |

SDK がベース URL に `/audio/transcriptions` を付けます。上記の whisper.cpp は
`/audio/transcriptions`、Kubernetes の共通 API は `/v1/audio/transcriptions` で受け付けます。
Compose の `.env` を変更した後は、ワーカーを再作成します。

```sh
docker compose up -d --force-recreate worker
```

whisper.cpp の開発用サーバーには認証がないため、待ち受け先はループバックのまま使います。
実音声での確認には、15 秒以上の発話を含む機密情報のないローカル動画と、
ワーカーの開発環境を使います。VideoQ のルートから次を実行します。

```sh
cd apps/worker
LOCAL_AI_TEST_WHISPER_BASE_URL=http://127.0.0.1:8080 \
LOCAL_AI_TEST_WHISPER_VIDEO=/absolute/path/to/speech.mp4 \
  .venv/bin/python -m pytest tests/test_local_whisper_integration.py -v
```

この明示実行のテストは、本番のワーカー処理で MP3 を抽出し、指定したサービスを呼び出します。
API が実際に返したセグメント時刻、元動画への時刻補正、字幕生成を確認します。
ストレージへのアップロードや DB 書き込みは行いません。Kubernetes の共通 API も `/v1` を含む
ベース URL で同じテストを使えます。通常の CI ではスキップし、音声モデルは取得しません。
オプションの詳細は [whisper.cpp のサーバー説明](https://github.com/ggml-org/whisper.cpp/blob/v1.9.5/examples/server/README.md)を参照してください。


## GitHub Actions での基本検証

`Local Inference Basic Checks` は、Linux x64・Linux ARM64・macOS ARM64 の標準ランナーで実行します。
関連変更の CI、手動実行、週次実行に対応しています。Helm の構成、チャット・音声・埋め込みの API 契約、
上流サーバーパッケージの CLI 起動を検証します。Linux は digest 固定の上流イメージ、macOS は Homebrew の
bottle を利用し、使用したバージョンを記録します。基本検証ではモデルの重みを取得しません。
モデルの精度、GPU／Metal の実行、アプリ全体のライフサイクルは別の受け入れ検証で確認します。
定義は `.github/workflows/local-inference-basic.yml` にあり、結果は
`local-inference-basic-<runner>` という artifact に7日間保存します。

2026-10-27 に、[3環境すべての基本検証が成功しました](https://github.com/yukiharada1228/videoq/actions/runs/40441493651)。
別途、[CPU amd64 のソースビルド受け入れ検証も成功しました](https://github.com/yukiharada1228/videoq/actions/runs/40440856356/job/121980594329)。
アップロード、日本語の実音声認識、索引作成、引用付き回答とストリーミング、Chromium の動画シーク、
オブジェクト・DB の復旧、更新とロールバックを確認しています。45文字の日本語評価音声では文字誤りが
ありませんでしたが、単一の短いサンプルであり、一般的な精度を保証するものではありません。
アプリの検証中は外部 IP 通信と外部 DNS を遮断しています。先行するワークフロー全体は、macOS の古い
Homebrew 索引による基本検証の失敗で赤く表示されますが、修正後の3環境の基本検証は上記のとおり成功しています。
GPU／Metal・ARM の実モデル推論、署名済みリリースの受け入れ検証は、この結果の対象外です。
