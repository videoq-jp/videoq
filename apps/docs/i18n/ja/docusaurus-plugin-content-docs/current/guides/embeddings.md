---
title: 埋め込みの設定と検証
description: EmbeddingGemma 2の768次元仕様、旧1536次元プロファイル、診断と移行。
---

# 埋め込みの設定と検証

クラウド版とオンプレ版の標準は、768次元のEmbeddingGemma 2です。APIとPython workerでモデル・プロファイル・前処理を揃えます。旧1536次元の索引は互換性や復旧のため別の領域に保持します。次元数が同じだけでは、同じベクトル空間とは限りません。

| 構成 | 次元数 | 保存先 |
|---|---|---|
| Workers AI / `embeddinggemma2` | 768 | D1のシーンとVectorizeの `videoq-prod-scenes-embeddinggemma2-768` |
| 社内のEmbeddingGemma 2 / `embeddinggemma2` | 768 | PostgreSQLの `scene_embeddings_768.embedding vector(768)` |
| 明示的な旧 `openai` プロファイル | 1536 | PostgreSQLの `scene_embeddings.embedding vector(1536)` または保持中の旧クラウド索引 |

## 外部または社内の接続先を選ぶ

クラウドAPIはCloudflareのAI Bindingを使います。

```dotenv
AI_PROVIDER=workers-ai
EMBEDDING_PROFILE=embeddinggemma2
EMBEDDING_MODEL=@cf/google/embeddinggemma-2
```

LambdaはAWSが発行する短期JWTを取得し、API Workerの固定の埋め込み経路を呼び出します。Cloudflareの推論キー、OpenRouter、AI Gatewayは使いません。[本番切り替え手順](https://github.com/videoq-jp/videoq/blob/main/docs/operations/openai-transcription.md)を参照してください。

社内のvLLMサービスでは、APIとworkerの両方を設定します。

```dotenv
AI_PROVIDER=openai
EMBEDDING_PROFILE=embeddinggemma2
EMBEDDING_MODEL=embeddinggemma-2-f9972ac
EMBEDDING_BASE_URL=http://embedding.intranet:8000/v1
EMBEDDING_API_KEY=local-inference
```

ここでの `openai` は互換プロトコルの指定です。仮のキーは社内サーバーの認証を無効にしている場合だけ使い、認証がある場合は実際のキーを実行環境のSecretで渡します。埋め込み専用の接続先を明示してください。Composeからホストの8001番ポートを使う場合は `http://host.docker.internal:8001/v1` です。`PGVECTOR_COLLECTION_NAME` を未設定にすると、プロファイルに対応するテーブルを選びます。チャットと音声には別の設定があります。[ローカル推論](local-inference.md)も参照してください。

質問には `task: search result | query: `、文書には `title: none | text: ` を一度だけ付けます。社内のEmbeddingGemma 2にはOpenAIの `dimensions` 上書きを送らず、本来の768次元出力を検証します。Workers AI Bindingでは768次元を明示します。旧llama.cpp/GTE・Qwen構成は `EMBEDDING_PROFILE=openai` と1536次元を明示します。

## 検証する内容

PostgreSQLの列宣言は、空のテーブルでも選択したプロファイルの次元数と照合します。列がない、次元数が違う、次元指定のないvector型である場合は失敗します。

各ベクトルは指定次元数ちょうどの有限数値で、float32に収まり、ゼロベクトルでないことが必要です。応答の件数とindexも入力に一致させます。切り詰め・ゼロ埋め・異なる空間の混在や、別の提供元への自動切り替えは行いません。

再索引では保存済みの字幕を変更しません。PostgreSQLでは置換ベクトル生成後に動画単位のトランザクションで行を置き換えます。クラウドでは元データの改訂番号を確認したステージングと不変のベクトルIDを使い、条件付きANN検索で見えることを確認して完了します。保存やupsert受付だけでは検索可能と判定しません。

## APIとworkerの診断を比較する

オンプレのPostgreSQLでは、モデル・プロファイル・接続先と `DATABASE_URL` を揃え、API・workerのディレクトリからそれぞれ実行します。

```bash
npm run embeddings:check
python -m worker_python.check_embeddings
```

モデルへの短い呼び出しも行う場合は `--probe` を追加します。npmでは `npm run embeddings:check -- --probe` です。APIスクリプトは `DOTENV_CONFIG_PATH`、Pythonはexportされた環境変数を読みます。Node/Pythonのこの診断にはWorkers AI Bindingがないため、クラウド推論はWorker実行環境と通常のLambdaジョブで検証します。

社内のGemma構成では `expected_dimensions: 768` と `db_dimensions: 768` を報告します。APIとworkerのprovider・model・profile・次元数を比較してください。ログに認証情報、接続文字列、入力本文、ベクトル本体は出しません。ヘルスチェックは有料の埋め込み呼び出しを行いません。

| 内部エラー | 意味 |
|---|---|
| `EMBEDDING_CONFIG_INVALID` | プロファイル・接続先の不備、または恒久的な提供元の拒否 |
| `EMBEDDING_SCHEMA_MISMATCH` | DBの列宣言が選択した仕様と不一致 |
| `EMBEDDING_OUTPUT_INVALID` | ベクトル値・件数・応答indexが不正 |

回答失敗時は予約した利用枠を戻し、workerは通常の再試行を使います。仕様違反はシーン分割でもエラーにします。タイムアウト・レート制限・サーバー障害では従来の分割フォールバックを使う場合がありますが、提供元は切り替えません。

## モデルの整合性

社内サービスでは重み・版・量子化・pooling・前処理を記録し、Workers AIでは固定のモデル識別子を記録します。既存環境のモデルを変える場合は、検索対象を再生成してから質問側を切り替えます。クラウドの段階移行では旧1536次元を保持し、768次元の全対象・改訂番号・検索可能性を確認してから質問側を切り替えます。切り詰めやゼロ埋めで旧ベクトルを流用しないでください。
