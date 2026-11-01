---
title: テストと確認コマンド
description: 変更箇所ごとに必要な確認を選び、DB・ブラウザ・外部APIの前提を確認する。
---

# テストと確認コマンド

まず変更箇所に近いテストを実行し、API契約やDBを変えた場合は利用側まで確認します。すべてのテストが同じ実行環境で動くわけではありません。

## どれを実行するか

すべてリポジトリルートからのコマンドです。

| 変更箇所 | 確認コマンド | 前提 |
|---|---|---|
| TypeScriptの共有契約 | `npm run typecheck` | `npm ci` 済み |
| 画面 | `npm run lint` / `npm run test:web` / `npm run build` | Node.js |
| 公開ページのWorkerとLPの動画配信 | `npm run test:worker --workspace @videoq/web` | 先に `npm run build` |
| API | `npm run test:api` | Node.jsとWorkersのテスト実行環境 |
| DB定義 | `npm run db:check` / `npm run db:verify` | 生成したmigration |
| UIの操作と見た目 | `npm run test:storybook` / `npm run build:storybook` | Chromium |
| 文書 | `npm run build:docs` | Node.js |

`npm test` はAPIとフロントエンドのテストを実行します。PythonとStorybookのテストは別コマンドです。

## APIの単体テストを絞る

```bash
npm run test:unit --workspace @videoq/api -- test/rag-agent.test.ts
```

APIの通常の `test` は、単体テストの後にWorkers環境のテストも実行します。Workers側だけなら次のコマンドです。

```bash
npm run test:workers --workspace @videoq/api
```

## DB統合テスト

一部のテストは実際のPostgreSQLとpgvectorを使います。`QUOTA_TEST_DATABASE_URL` を指定しない場合にスキップされるテストがあるため、単体テストの成功だけでDBの挙動まで確認できたとは判断しません。

```bash
QUOTA_TEST_DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:55432/postgres npm run test:api
```

上記は標準ローカル接続先の例です。**検証用DBだけを指定してください。** テストによってDB・スキーマを作成して後片付けするため、接続ユーザーにはテストDBの作成権限も必要です。

## 画面・Storybook

特定のフックを確認する例です。

```bash
npm test --workspace @videoq/web -- src/hooks/__tests__/useTags.test.ts
```

Storybookの操作テストには、先にChromiumを導入します。

```bash
npm exec --workspace @videoq/web -- playwright install chromium
npm run test:storybook
```

画面遷移や親レイアウトを変更した場合は `src/__tests__/App.navigation.test.tsx` と `Application/Navigation` のStoryも確認します。

## Python worker

Python 3.12以上で、専用の仮想環境を作ります。次のコマンドだけは `apps/worker/` に移動して実行します。

```bash
cd apps/worker
python3 -m venv .venv
. .venv/bin/activate
python -m pip install -e '.[dev]'
python -m pytest tests/ -q
```

DBを使うworkerテストには、テスト用の `DATABASE_URL` が必要です。個別のテストの前提も確認してください。

## 実モデルを使うテスト

回答処理を変更したときは、実モデルを呼ぶ前に固定データのテストで確認します。

| 確認する挙動 | 対応するテスト |
|---|---|
| ツールの選択・アクセス範囲・独立した質問 | `apps/api/test/rag-agent.test.ts` |
| 構造化出力・逐次配信・引用の境界 | `apps/api/test/structured-answer.test.ts`、`apps/api/test/answer-content-stream.test.ts` |
| 描画フレーム・非表示タブ・完了・中断 | `apps/web/src/lib/__tests__/chatStreamController.test.ts` |

通常のCIとは別に、モデルが検索ツールを適切に選ぶかを確認するテストがあります。

```bash
RAG_SELECTION_LIVE=1 npm run test:unit --workspace @videoq/api -- test/rag-agent-selection.live.test.ts
```

これはOpenAI互換APIへ実際に接続し、利用料金が発生します。`OPENAI_API_KEY`、`OPENAI_BASE_URL`、`LLM_MODEL` は環境変数またはAPIの `.dev.vars` から読みます。初回参加時の必須手順ではありません。

**関連:** [最初の変更](../getting-started/first-change.md)、[困ったとき](troubleshooting.md)。

構造化回答の有料比較テストとブラウザー測定は[切り替えと検証](../architecture/structured-answers.md)を参照してください。
