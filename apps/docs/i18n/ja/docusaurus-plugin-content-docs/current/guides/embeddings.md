---
title: 埋め込みの設定と検証
description: 1536次元固定の仕様、モデル・接続先の設定、診断方法、モデルの整合性。
---

# 埋め込みの設定と検証

VideoQはシーンの埋め込みを `scene_embeddings.embedding vector(1536)` に保存します。API・Python workerの次元数は定数 `EMBEDDING_DIMENSIONS = 1536` で固定です。API・worker は同じ固定の保存形式と出力条件を検証します。

## 外部または社内の接続先を選ぶ

埋め込みは OpenAI 互換 API に統一しています。標準設定は次のとおりです。

```dotenv
OPENAI_BASE_URL=https://openrouter.ai/api/v1
EMBEDDING_MODEL=openai/text-embedding-3-small
```

API・worker の両方に `OPENROUTER_API_KEY` を設定します。モデルは1536次元の OpenAI text-embedding-3-small のままで、OpenRouter の名前空間を付けただけでは再索引は不要です。社内の llama.cpp／vLLM も同じ形式を使い、接続先とモデル名を明示します。

```dotenv
EMBEDDING_BASE_URL=http://embedding.intranet:8000/v1
EMBEDDING_API_KEY=local-inference
EMBEDDING_MODEL=gte-qwen2-1.5b-q4km-124fbdad
```

認証不要の社内サーバーでは仮のキーを使います。`EMBEDDING_API_KEY` が空なら
接続先に応じたキー（OpenRouter なら `OPENROUTER_API_KEY`、それ以外は `OPENAI_API_KEY`）、`EMBEDDING_BASE_URL` が空なら `OPENAI_BASE_URL` を使用するため、
埋め込みを別サービスに配置する場合は専用 URL を必ず設定してください。
Compose からホストの 8001 番ポートに接続する例は `http://host.docker.internal:8001/v1` です。
API・worker のモデル名と接続先を揃えます。LLM と Whisper の設定は独立しています。
[ローカル AI 推論](local-inference.md)も参照してください。

`POST /v1/embeddings` に `dimensions: 1536`、`encoding_format: float`、model、input を送ります。
llama.cpp 構成は元の出力が 1536 次元の gte-Qwen2、vLLM 構成は次元削減を明示した
Qwen3-Embedding-4B を使います。不正な出力を切り詰めたり、ゼロ埋めしたり、次元指定を
外して再試行したり、外部サービスへ自動的に切り替えたりしません。

API の形式は固定です。モデル名は前後空白を除去し、大小文字は保持します。空なら
`text-embedding-3-small` を使うため、社内の実際のモデル名と接続先を明示してください。

出典は [OpenAI の埋め込み](../reference/ai-references.md#openai-embeddings)、Qwen3 を使う場合は
[Qwen3 Embedding](../reference/ai-references.md#qwen3-embedding)を参照し、重みの revision、量子化、
配備したイメージを記録してください。

## 何を検証するか

シーン検索・索引作成を行う経路では、DBの宣言型が `vector(1536)` か確認します。空テーブルでも検出し、列欠落・別型・次元未固定の `vector` は拒否します。

生成ベクトルは、1536個の有限な数値からなり、pgvectorのfloat32に収まり、非ゼロである必要があります。文字列や真偽値を数値に変換して受け入れません。バッチ件数とOpenAIの応答indexも入力に対応するか検証します。

シーン分割も共通の出力検証を使いますが、単独の計算にはDB接続を要求しません。契約違反は正常なフォールバックとして隠さず失敗させます。純粋なデータ削除にはモデル呼び出しや認証情報を要求しません。

全体再索引では、対象動画がある場合にDBの埋め込み契約を確認し、**動画1本分の新しい埋め込みをすべて生成・検証してから、その動画の既存行を変更**します。現在の動画行をロックして字幕を再確認し、1つのトランザクションで行を置き換えます。失敗した動画の旧索引は保持し、ほかの動画は処理を続けます。1件でも失敗すれば再試行のためジョブを失敗にします。最初に全索引を削除する処理や、別途短い入力でモデルを試す処理はありません。必要なら下記の `--probe` 診断を明示的に実行します。原子的な置き換えの単位は動画ごとであり、索引全体ではありません。

## APIとworkerの診断結果を比較する

各実行環境で有効なモデル・接続先と、そのDBを指す `DATABASE_URL` を設定します。以下はAPI・workerそれぞれのディレクトリで実行します。APIは `DOTENV_CONFIG_PATH` でdotenvファイルを指定できます。Pythonはexport済み環境変数を読みます。

```bash
# apps/api: 設定とDBの宣言型のみ
npm run embeddings:check
# apps/worker: workerをインストールしたPython環境で実行
python -m worker_python.check_embeddings
```

短い診断入力でモデル出力も検証する場合は、明示的に `--probe` を付けます。外部APIの利用料金が発生する場合があります。

```bash
# apps/api
npm run embeddings:check -- --probe
# apps/worker
python -m worker_python.check_embeddings --probe
```

DB検証の成功時は次のようなJSONが出力されます。

```json
{"event":"embedding.validation","provider":"openai","model":"text-embedding-3-small","expected_dimensions":1536,"db_dimensions":1536}
```

出力検証では `actual_dimensions` も出ます。両環境の `provider`・`model`・次元の項目を比較してください。診断ログに認証情報・接続文字列・入力文・ベクトル本体は含めません。起動やヘルスチェックだけで有料Embeddingを生成することはありません。

| 内部理由 | 意味 |
|---|---|
| `EMBEDDING_CONFIG_INVALID` | workerの埋め込み要求に対するHTTP 4xxの拒否（408/429を除く） |
| `EMBEDDING_SCHEMA_MISMATCH` | DBの宣言型が `vector(1536)` と異なる |
| `EMBEDDING_OUTPUT_INVALID` | モデル出力・件数・indexが不正 |

Q&Aの公開エラーは既存の分類を維持します。設定・スキーマ不整合はHTTP 400の `VALIDATION_ERROR` またはSSEの `LLM_CONFIGURATION_ERROR`、出力不整合はHTTP 500の `INTERNAL_ERROR` またはSSEの `LLM_PROVIDER_ERROR` です。失敗した回答では予約済み利用枠を解放します。workerは既存の失敗・再試行処理に接続します。

workerは、非対応モデル・次元指定などに対する恒久的な拒否をシーン分割の上位へ伝えます。providerのエラー本文はログに出しません。タイムアウト・利用制限・サーバー障害は、シーン分割の既存フォールバックを維持します。

## モデルの整合性

保存済みベクトルと検索用ベクトルは、同じ重み・revision・量子化・pooling・前処理を
使う必要があります。同じ次元数でも異なるモデルのベクトルは混在できません。
保存行にモデルの来歴は記録されないため、採用した設定を記録し、API・worker の診断を照合します。

初期導入時は、選んだモデル設定でデータベースを初期化します。運用中にモデルを変える場合は、
Q&A とインデックス更新を止めてシーンの埋め込みを再生成し、その後に検索を再開してください。
現在のアプリケーションとデータベースは、出力を 1536 次元に固定しています。
