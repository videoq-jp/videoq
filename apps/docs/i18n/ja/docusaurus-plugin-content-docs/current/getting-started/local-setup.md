---
title: 開発環境を動かす
description: Docker Compose で VideoQ を起動し、ローカルアカウントでログインするまで。
---

# 開発環境を動かす

このページのゴールは、自分のPCで VideoQ を起動し、ログインできることです。まずは Docker Compose に API・DB・動画処理を任せる構成で始めます。

文書だけを直す場合は、[ドキュメントを更新する](../guides/documentation.md)へ進んでください。アプリの起動は不要です。

## 用意するもの

| 必要なもの | 用途 |
|---|---|
| Git とリポジトリへのアクセス | ソースコードの取得 |
| Docker と Docker Compose | DB、API、動画処理などの起動 |
| Node.js と npm（`.node-version` の版） | 依存関係の導入、ローカルアカウントの設定 |
| 開発用の OpenRouter API キー | 文字起こし、検索用データの生成、AI回答 |

この手順の動画処理・AI回答では外部APIの利用料金が発生します。開発用のキーと短い検証動画を使ってください。YouTube取り込みを試す場合だけ、別途 SearchAPI のキーが必要です。

## 1. コードと設定ファイルを用意する

```bash
git clone https://github.com/videoq-jp/videoq.git
cd videoq
cp -n .env.example .env
npm ci
```

以降のコマンドは、特に記載がなければリポジトリルートの `videoq/` で実行します。すでに作業用コピーがある場合は、clone を省略してください。

## 2. 開発用のAI設定を入れる

`.env` の同名項目を次の値に編集します。`OPENROUTER_API_KEY` には自分の開発用キーを入れてください。

```dotenv
OPENROUTER_API_KEY=ここに開発用キーを入力
OPENAI_BASE_URL=https://openrouter.ai/api/v1
LLM_MODEL=openai/gpt-6-luna
EMBEDDING_MODEL=openai/text-embedding-3-small
WHISPER_BACKEND=openrouter
```

いずれも `.env.example` の値と同じなので、通常はキーを追加するだけです。`WHISPER_BACKEND=openai` は旧来の直接接続で、別途 `OPENAI_API_KEY` が必要です。

回答生成と画像確認は共通の `LLM_MODEL` を使い、ここでは OpenRouter 経由の GPT-6 Luna を指定しています。映像確認を有効にする場合は、画像入力・ツール呼び出し・厳密なJSON出力に対応したモデルを指定してください。[モデル設定](../architecture/prompt-engineering.md#モデル設定と処理の上限)も参照してください。

設定テンプレートも上記の埋め込み設定を使用します。次元は1536固定で、次元数の環境変数は不要です。API・workerのproviderとmodelを揃えてください。社内の llama.cpp／vLLM の接続設定と診断コマンドは[埋め込みの設定と検証](../guides/embeddings.md)を参照してください。

次のコマンドで2つの開発用秘密鍵を生成します。

```bash
openssl rand -base64 48
openssl rand -base64 32 | tr '+/' '-_' | tr -d '='
```

1つ目の出力を `.env` の `AUTH_JWT_SECRET`、2つ目を `USER_SECRET_ENCRYPTION_KEY` に設定します。

`AUTH_JWT_SECRET` は現在のCompose起動スクリプトが使う互換設定名です。ブラウザの認証方式は Better Auth のCookieセッションです。ホストでAPIを直接動かすときは `BETTER_AUTH_SECRET` を使います。[認証の仕組み](../concepts/auth.md)に違いをまとめています。

## 3. サービスを起動する

```bash
docker compose up --build -d
docker compose ps -a
```

初回はイメージの取得・ビルドがあるため、起動まで時間がかかります。

- `postgres`、`api`、`worker`、`web`、`gateway` などが起動していれば次へ進めます。
- `migrate` と `garage-init` は準備が終わると停止します。終了コードが `0` なら正常です。
- 失敗したサービスがある場合は `docker compose logs --tail=100 migrate api worker` で原因を確認します。

```bash
curl -fsS http://localhost/health
curl -fsS http://localhost/ready
```

`/health` はAPIが応答すること、`/ready` はDBにも接続できることを確認します。`/ready` の正常な応答は次の形です。

```json
{"data":{"status":"ready","db":"ok"}}
```

## 4. アカウントを作ってログインする

1. [ローカルの登録画面](http://localhost/signup)でユーザーを作成します。
2. メールを設定していないローカル環境では、次のコマンドでそのアカウントを有効化・管理者化します。`your-username` を登録したユーザー名またはメールアドレスに置き換えます。

```bash
npm run user:admin --workspace @videoq/api -- your-username
```

3. [ログイン画面](http://localhost/login)でログインします。

この昇格手順は自分のローカル開発DB向けです。既定の接続先はホストの `127.0.0.1:55432` です。既存の `DATABASE_URL` を設定している場合は、実行前に接続先を確認してください。

## 5. 画面を編集する場合

標準構成の `http://localhost` はビルド済みの画面を表示します。編集をすぐ反映するには、Viteの開発サーバーを追加します。

```bash
docker compose --profile dev up --build -d web-dev
```

開発時は [http://localhost:3000](http://localhost:3000) を開きます。`http://localhost` の静的画面とは別の入口です。

## 終了と再開

```bash
docker compose stop
docker compose up -d
```

`stop` ではローカルのDBや動画を保持します。`.env` を変更した場合は、対象サービスを再作成して設定を読み直します。

```bash
docker compose up -d --force-recreate api worker
```

Docker経由のAPI起動時は `apps/api/.dev.vars` が生成されます。このファイルへの手編集は次回起動で上書きされるため、Compose構成では `.env` を編集してください。ただし転送される項目は起動スクリプトで限定されています。

**次に読む:** [動画を登録して質問する](first-walkthrough.md)。起動できない場合は[困ったとき](../guides/troubleshooting.md)へ進みます。
