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
| NVIDIA GPU | 3モデルを上流 vLLM で実行 | `local-ai-gpt-oss.yaml` |
| CPU | llama.cpp。回答用・埋め込み用を別サービスに配置 | `local-ai-llamacpp.yaml` |
| NVIDIA GPU | vLLM。回答用・埋め込み用を別サービスに配置 | `local-ai-vllm.yaml` |

推奨するモデルは **gpt-oss-20b + EmbeddingGemma 2 + Whisper large-v3-turbo** です。
推論側の `charts/videoq-inference/examples/gpt-oss-embeddinggemma.yaml` と、
アプリ側の `charts/videoq/examples/local-ai-gpt-oss.yaml` を組み合わせます。
LLM・埋め込み・Whisper に、それぞれ専用の NVIDIA GPU を1台ずつ割り当てます。
従来の Qwen 構成も互換性確認用に残しています。小さい CPU 専用 VPS では、
LLM の接続先を別の社内 GPU サーバーに設定してください。

EmbeddingGemma 2 は vLLM の pooling で実行します。質問には `SearchQuery`、
字幕には `Document` のプロンプトを適用し、正規化した768次元を返します。
`ai.embeddingProfile: embeddinggemma2` を API・ワーカーの両方に適用します。
API・ワーカーが用途に応じた固定プレフィックスを入力に付け、通常の OpenAI 互換 API に送ります。

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
エンコーダーはアプリから利用しません。映像を直接検索するには別途インデックス処理の実装が必要です。
`separateToolSchema: true` で、検索ツールを選ぶ処理と最終回答の JSON 形式の強制を分けます。
検索を最終回答用の制約で抑制しないための互換設定です。

推論エンジンは Chart で digest 固定した上流イメージを使い、自前ビルドは行いません。
不足する音声依存は SHA-256 固定した上流 wheel で補い、別の読み取り専用ボリュームに配置します。
初回取得した wheel をモデル用 PVC に保存し、オフライン再起動でも検証・展開できます。
各リリースで上流イメージの脆弱性・実ファイル・音声依存の検査を必須にしています。固定した3モデルは L40S 上で順番に実行し、API 契約を確認済みです。導入先の容量とドライバー互換性は別途検証してください。
[推論用 Chart の構成](https://github.com/videoq-jp/videoq/blob/main/charts/videoq-inference/README.md#recommended-gpt-oss--embeddinggemma-2--whisper-profile)
を参照してください。

文字起こしは **CPU で whisper.cpp、NVIDIA GPU で vLLM** を使います。
どちらも社内の共通 API を経由し、VAD と音量補正の後に認識し、字幕時刻を元の動画へ戻します。
Mac の手元開発では、Metal を使うネイティブの whisper.cpp も利用できます。
アプリの設定名は `WHISPER_BACKEND=local` に統一し、`WHISPER_LOCAL_URL` で接続先を指定します。

従来の `vllm-nvidia.yaml` の API は音声2件までを受け付け、各音声から最大4区間を並行して vLLM に送信します。
vLLM は最大8区間を動的にまとめて推論します。動画が8件たまるのを待つ方式ではありません。
CPU は音声1件ずつ処理し、ワーカーの永続チェックポイントは30秒、NVIDIA は300秒です。
`ai.whisperChunkSeconds` で30〜300秒に調整できます。CPU の標準モデルは多言語の
量子化 large-v3-turbo（Q5_0）です。速度と日本語の認識品質は、導入先の機器・録画で確認してください。

CPU の推論エンジンは2コアを予約します。API は音声1件の全区間を合わせて600秒、
ワーカーは660秒まで待ちます。NVIDIA の設定では API 側を110秒にします。
`whisper.requestTimeoutSeconds` は1〜600秒で指定でき、区間ごとに期限を延長することはありません。

API の形式は OpenAI 互換に統一し、`EMBEDDING_BASE_URL` で社内の埋め込み API を指定します。LLM の `OPENAI_BASE_URL` とは
独立して設定します。認証も分ける場合は Secret に `EMBEDDING_API_KEY` を設定します。

具体的なコマンドは、[推論用 Chart の導入手順](https://github.com/videoq-jp/videoq/blob/main/charts/videoq-inference/README.md)
にあります。署名付きイメージと推論用 Chart の導入、CPU・NVIDIA GPU の設定、モデルの永続化、
導入後のダウンロード停止、通信制限、実モデルの確認手順をまとめています。
アプリ側は `charts/videoq/examples/` の対応する設定を重ね、更新時も同じ設定を維持します。

CPU の基本構成では、テキスト専用モデルを使うため映像の視覚解析を無効にします。
文字起こし・字幕検索・引用付き回答・タイムスタンプ再生は利用できます。
視覚解析も社内で使うには、画像入力・ツール呼び出し・JSON Schema 出力に対応した
ローカルモデルを別途検証します。vLLM の基本設定例は、LLM・埋め込み・Whisper に
1 GPU ずつ、合計3 GPU を割り当てます。LLM・埋め込みを CPU のまま使う場合は、
`whisper-nvidia.yaml` を重ねて文字起こしだけに GPU を割り当てられます。vLLM の GPU 実行・ドライバー互換性は実機での検証が必要です。
日本語の認識・回答品質と処理能力も導入先で確認します。

[署名付き Public 配布](on-premises-releases.md)に CPU 用 Whisper、amd64 用 NVIDIA vLLM、推論用 Chart を含めます。
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

## Mac で whisper.cpp を使う

Apple Silicon の Metal を使うため、whisper.cpp は macOS 上で直接起動します。
Kubernetes では CPU に whisper.cpp、NVIDIA に vLLM を配置し、共通 API を経由します。

Mac に CMake・C++ のビルド環境・FFmpeg を用意し、VideoQ のルートで実行します。

```sh
git submodule update --init --recursive
cd whisper.cpp
cmake -B build -DCMAKE_BUILD_TYPE=Release
cmake --build build -j --config Release
bash ./models/download-ggml-model.sh large-v3-turbo
./build/bin/whisper-server -m models/ggml-large-v3-turbo.bin \
  --host 127.0.0.1 --port 8080 --inference-path /audio/transcriptions \
  --convert -l auto
```

同梱のサブモジュールでサーバーのバージョンを固定しています。モデルは導入時に取得し、
起動後はローカルのファイルを読み込みます。ワーカーは MP3 を送るため、Mac 側の
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

`Local Inference Basic Checks` は、Linux x64・Linux ARM64・macOS ARM64 の
標準ランナーで、チャート構成、アプリと worker の API 契約、上流サーバーの CLI 起動を検証します。
関連変更の CI、手動実行、週次実行に対応します。モデルは取得せず、推論精度、GPU／Metal の
実行、アプリ全体の受け入れ検証は対象外です。

Linux はチャートの digest 固定 llama.cpp と、`.github/inference-basic-packages.json` の
上流 whisper.cpp 候補を確認します。候補の検証によって導入済みの音声エンジンは変わりません。
macOS は Homebrew の索引を更新して bottle を利用し、バージョンを記録します。
成果物は `local-inference-basic-<runner>` として7日間保存します。既存の脆弱性検査と
リリースゲートは維持します。


## CPU 音声エンジンの上流パッケージ

CPU の whisper.cpp は、VideoQ イメージ内での再ビルドをやめ、digest 固定の上流イメージを
別コンテナーで起動します。VideoQ の音声前処理・API は従来のゲートウェイに残し、エンジンは
同じ Pod 内の loopback で接続します。既存の NVIDIA イメージと脆弱性検査は維持します。
ARM64 では `charts/videoq-inference/examples/cpu-arm64.yaml` を使用します。モデルの取得後は
オフラインで再起動できます。上流イメージの脆弱性検査は amd64・arm64 で個別に行い、
レビュー済みのヘッダー評価を適用する前に、全ファイルの一覧・ハッシュ・パッケージを照合します。
評価済みの指摘も検査成果物に残ります。ホストカーネルの安全性を保証するものではありません。

AMD／ROCm の構成追加は別の変更で扱い、対象 GPU・OS が未定のため実機動作は未確認です。
GPU の採用には実機検証と脆弱性評価が必要です。
