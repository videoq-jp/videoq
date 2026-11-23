---
title: 動画の非同期処理を変更する
description: メディア処理、TypeScriptのバックグラウンドジョブ、再試行とローカル検証。
---

# 動画の非同期処理を変更する

Pythonは文字起こし、画像の準備、区間処理と結合などのメディア処理を担当します。検索索引の作成とアカウント削除は、`apps/api` の共通TypeScript実装が担当します。APIの操作では、ジョブを配送する前に配送予定をDBへ永続化します。

## 処理の入口

| 変更したいこと | 主な場所 |
|---|---|
| メディアジョブの種類と振り分け | `apps/worker/worker_python/contracts.py`、`tasks/registry.py` |
| メディア処理とプロバイダー接続 | `apps/worker/worker_python/use_cases/`、`tasks/`、`pipeline/` |
| メディアの実行権とLambdaの入口 | `apps/worker/worker_python/job_execution.py`、`lambda_handler.py` |
| 検索・アカウントジョブの検証 | `apps/api/src/application/background-job.ts` |
| 共通TypeScriptジョブの実行 | `apps/api/src/integrations/background-jobs/execute.ts` |
| Cloudflareでの配送と受信 | `apps/api/src/integrations/background-jobs/delivery.ts`、`queue.ts` |
| クラウド検索の永続ワークフロー | `apps/api/src/workflows/search-index.ts` |
| オンプレのバックグラウンドworker | `apps/api/src/runtime/background-worker.ts` |
| PostgreSQLのベクトル置換 | `apps/api/src/persistence/postgres/transcript-index-writer.ts` |

共通のメッセージ形式は [job-message.ts](https://github.com/videoq-jp/videoq/blob/main/apps/api/src/lib/job-message.ts)にあります。

## ホスト環境の実行系統

メディア用Lambdaは既存のSQSキューとDLQを使います。検索索引の作成予定は署名付き内部APIへ渡します。Pythonで検索用の埋め込み計算やベクトル書き込みを直接実行しません。

Cloudflare Queuesから、アカウントジョブはAPI Workerのキューハンドラーへ、検索ジョブは `SearchIndexWorkflow` へ渡します。ワークフローはWorkers AI、D1、R2のチェックポイント、Vectorizeを使います。検索キューの受信側は永続ワークフローが作成された時点で配送を確認します。配送完了とワークフロー全体の完了は別です。

移行時は本番の配送先切り替え、旧設定での最大実行時間の経過、可視・処理中・遅延メッセージとDLQの排出確認を終えてから、旧search/account Lambdaとキューを撤去します。移行条件は [worker README](https://github.com/videoq-jp/videoq/blob/main/apps/worker/README.md)と[デプロイ手順](https://github.com/videoq-jp/videoq/blob/main/infra/DEPLOY.md)を参照してください。

## オンプレの実行系統

Nodeの `background-worker` サービスが、検索とアカウント用の専用SQS互換キューを受信します。Pythonの `worker` サービスはメディアジョブを受信します。Composeには両方のサービスがあり、HelmではNode workerと用途別のキューURLが必要です。

検索にはPostgreSQLと `@yukiharada1228/langchain-postgres` を使います。埋め込みは `@langchain/openai` を通して設定済みのOpenAI互換エンドポイントを呼び出します。ローカル推論サービスを使えば外部通信なしで実行できます。オンプレではCloudflareのストレージバインディングは不要です。

## メッセージの形

```json
{
  "type": "transcribe_video",
  "job_id": "ジョブを識別するUUID",
  "payload": {"video_id": 123}
}
```

通常はAPIの操作でジョブを作り、手でキューへ投入する必要はありません。

アップロード動画では、`transcribe_video` が区間を計画し、`transcribe_video_chunk` が区間ごとに保存し、`finish_video_transcription` が結合します。その後の索引作成はTypeScriptへ渡し、画像キャッシュのジョブはPythonで実行します。YouTube取り込みに区間ジョブはありません。[動画の状態](../design/state-diagram.md)も参照してください。

## 再試行を前提にする

キューは同じメッセージを複数回届ける可能性があります。両ランタイムは `job_executions`、同じジョブID、期限付きの実行権を使い、完了したジョブはスキップします。それぞれの更新でもリビジョンや所有権の条件を守ります。実行権だけで任意の外部操作が一度だけ実行されるわけではありません。

クラウド検索はステップごとの進捗を永続化し、大きな字幕やベクトルの中間データをR2へ保存します。ベクトルの公開と検索可能になる時点は別です。アカウント削除では、有効な実行権、ユーザーの恒久的な利用停止、対応するoutboxの削除予定を再確認しながら処理します。

全件再索引では、1ジョブにつき最大25動画のIDを配送し、次ページの継続処理を保存します。動画ごとに完了と再試行を管理します。親ジョブの成功は配送を意味し、すべての動画の処理完了を意味しません。

## DBトランザクションの区切り

PythonによるPostgreSQL上のメディア処理は `with db_connection() as conn` で囲みます。正常終了時はコミット、例外時はロールバックし、コミットに失敗しても接続を閉じます。プロバイダー呼び出しはトランザクションの外で行います。

TypeScriptによるPostgreSQLの索引作成は、字幕スナップショットと保存先の次元数を検証した後、動画のベクトルを原子的に置換します。`PGVectorStore` のエンジンはトランザクションと同じ接続を使います。D1では変更しないシーンリビジョンを準備し、条件付きで公開してからVectorizeの検索準備完了を待ちます。アダプターを変更するときも、この処理単位を維持します。

## ローカルで追う

コードを変更したサービスを再起動します。依存パッケージを変更した場合はイメージも再ビルドします。

```bash
docker compose restart worker background-worker
docker compose logs --tail=100 worker background-worker
docker compose logs -f worker background-worker
```

画面から短い動画を登録し、対象の動画IDでログを追います。`Ctrl+C` でログ表示を止めてもサービスは動き続けます。文字起こしや埋め込みの問題では、設定した推論エンドポイントを確認します。

API、worker、オンプレの検証は[テストの使い分け](testing.md)を参照してください。接続先やモデル設定は [worker README](https://github.com/videoq-jp/videoq/blob/main/apps/worker/README.md)にあります。

**関連:** [ジョブの配送と回復](../architecture/flowchart.md)。
