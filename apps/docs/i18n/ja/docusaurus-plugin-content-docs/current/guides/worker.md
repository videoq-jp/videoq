---
title: 動画の非同期処理を変更する
description: ジョブの入口、処理本体、再試行の考え方とローカルでの確認方法。
---

# 動画の非同期処理を変更する

文字起こしや索引作成は時間がかかるため、APIの応答を待たせずにPython workerで実行します。APIは「この動画を処理してほしい」というジョブをキューへ送り、workerが受け取ります。

## 処理の入口

| 変更したいこと | 主な場所 |
|---|---|
| ジョブの種類・データ形式 | `apps/worker/worker_python/contracts.py` |
| ジョブ名と処理関数の対応 | `worker_python/tasks/registry.py` |
| 状態更新・次のジョブへの受け渡し | `worker_python/tasks/` |
| 文字起こし・検索用データの処理本体 | `worker_python/pipeline/` |
| 重複実行の制御 | `worker_python/job_execution.py` |
| AWS Lambdaの入口 | `worker_python/lambda_handler.py` |

ファイルの実体はすべて `apps/worker/` 配下にあります。API側のメッセージ形式は [job-message.ts](https://github.com/videoq-jp/videoq/blob/main/apps/api/src/lib/job-message.ts)も確認します。

## メッセージの形

```json
{
  "type": "transcribe_video",
  "job_id": "ジョブを識別するUUID",
  "payload": {"video_id": 123}
}
```

上記は形式の例です。通常はAPIの操作でジョブを作り、手でキューへ投入する必要はありません。

アップロード動画では、`transcribe_video` が区間の計画を作り、`transcribe_video_chunk` が区間ごとに保存し、`finish_video_transcription` がそれらを結合してから `index_video_transcript` と画像キャッシュのジョブ（`build_video_visual_chunk` → `finish_video_visuals`）を開始します。YouTube取り込みに区間ジョブはありません。[動画の状態](../design/state-diagram.md)も参照してください。

開始できる状態は各タスクで検証し、DBの条件付き更新でも保存済みの状態を確認します。
文字起こしは pending/error から開始し、processing は再開、indexing は索引タスクへ
引き継ぎ、completed の重複配送はスキップします。uploading や未知の状態では、
DB更新や外部API呼び出しの前に拒否します。

## 再試行を前提にする

SQSは同じメッセージを複数回届ける可能性があります。workerは `job_id` の実行記録と期限付きの実行権を使い、完了した処理の重複を避けます。後続ジョブのIDも親ジョブから決定します。

処理を追加するときは「途中で失敗して再実行されても、データや後続ジョブが重複しないか」を確認します。これを冪等性と呼びます。例外を握り潰すと再試行されず、状態だけが途中で残ることがあります。

タスクは結果データを返しません。dispatcherはタスクが正常に戻った後に完了を記録し、
例外が出た場合は既存の再試行処理へ渡します。全動画の再索引では件数をログへ記録し、
失敗した動画があれば例外を送出します。

## DBトランザクションの区切り

DB処理の単位を `with db_connection() as conn` で囲みます。正常終了時はコミット、
例外時はロールバックし、コミット自体が失敗しても接続を閉じます。文字起こし・埋め込み・
評価の外部API呼び出しはブロックの外で行い、待機中にDB接続やトランザクションを
保持しないようにします。
接続を受け取るヘルパーは呼び出し元のトランザクション内でSQLを実行し、確定時点は
呼び出し元が管理します。

一つの接続で複数のトランザクションを扱う場合は、途中の明示的なコミットが必要です。
アカウント削除では完了した段階ごとに確定し、動画ごとにもトランザクションを区切ります。
ストレージ削除の失敗後も、残っている処理を再試行できます。

## ローカルで追う

Pythonのコードを編集したら、起動中のworkerを再起動して読み直します。依存パッケージを変更した場合はイメージの再ビルドも必要です。

```bash
docker compose restart worker
```

```bash
docker compose logs --tail=100 worker
docker compose logs -f worker
```

画面から短い動画を登録し、対象の動画IDでログを追います。`Ctrl+C` でログ表示を止めてもworkerは動き続けます。文字起こし・埋め込みを実行すると、設定した外部APIが呼ばれます。

Pythonのテスト環境とコマンドは[テストの使い分け](testing.md)を参照してください。接続先やモデル設定は [worker README](https://github.com/videoq-jp/videoq/blob/main/apps/worker/README.md)にあります。

**関連:** [ジョブの配送と回復](../architecture/flowchart.md)。
