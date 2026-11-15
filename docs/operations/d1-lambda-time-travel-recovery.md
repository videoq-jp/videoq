# 実Lambda・SQSを停止したD1 Time Travel復旧

2026-11-15。専用のCloudflare Worker/D1、AWS Lambda/SQSで、取り込み停止、D1 Time Travel復旧、再開を検証した。本番と同じdigest固定のPython Workerイメージを使用し、Honoの実内部APIと署名検証、D1の実Repositoryを通した。[集計証跡](evidence/d1-lambda-time-travel-recovery-2026-11-15.json)。

## 検証経路

新規の専用D1へ現行の20マイグレーションを適用し、実Honoアプリを専用Workerに配置した。検証用wrapperは期限付きで、署名認証を通すジョブ操作とアカウント削除のPOSTだけを受け付ける。モデル・R2・Vectorizeの資格情報や本番DB接続は設定しなかった。

専用Lambdaは、本番アカウント削除Workerと同じarm64イメージdigestを使用した。実行権限は期限付きのpermissions boundaryとinline policyで専用キューの取得・ACK・可視性変更、専用ログの書き込みに限定した。SQSは管理暗号化、短い保持期間、専用DLQ、visibility timeout 180秒、Lambda timeout 30秒とし、mappingはbatch size 1とReportBatchItemFailuresを指定した。既存ECRポリシーは変更していない。

1. 動画・外部課金情報を持たない合成ユーザー2件と、送信済みOutboxを作成した。実Python Workerの標準`{type, job_id, payload}`形式でSQSへ送信した。
2. 1件目を実Lambdaで処理し、署名付きHono API経由のユーザー削除とジョブ完了を確認した。
3. event-source mappingがDisabledになるまで待ち、reserved concurrencyを0にした。2件目は署名付きclaim/fail APIで失敗状態にし、全アプリテーブル・スキーマ・採番情報の2回の取得結果が一致することを確認した。
4. 復旧bookmarkを取得し、停止中のキューに失敗ジョブと完了済みジョブの重複を残した。D1に復旧確認用マーカーを書き込み、専用D1だけをTime Travelで復元した。
5. マーカーの消失、基準状態とのハッシュ一致、foreign_key_checkが空であることを確認した。
6. concurrencyと実mappingを再開した。失敗ジョブはattempts 2で完了してユーザーを削除し、完了済みジョブは再実行しなかった。再試行済みジョブにも明示的な重複を追加した。
7. CloudWatchで送信4 MessageIdの実Worker完了ログと2回以上のcompleted duplicate skipを照合した。最初のジョブはattempts 1、再試行ジョブはattempts 2を維持した。キューとDLQの最終long pollは空だった。
8. mappingを停止し、専用Lambda、mapping、IAM role/boundary、2キュー、ログ、Worker、3 Durable Object namespace、D1を撤去し、管理APIで不存在を確認した。ローカルの検証用秘密値コピーも削除した。

最初のbookmark取得ではWorker名とDB名を取り違え、コマンドが失敗した。DB bindingを指定して停止状態の同じ基準データから再開し、復旧試験を完了した。失敗を復旧成功として集計していない。

## 適用範囲

これは**実Lambda mappingと署名付き内部APIを通すD1 Time Travel復旧**である。既存の[実SQSとD1→PostgreSQL復旧試験](d1-sqs-recovery-replay.md)はローカルconsumerであり、今回と合わせて「実LambdaでPostgreSQLへ切り戻した」とは扱わない。

合成ユーザーは動画0件のため、R2削除、Vectorize削除、Stripe、ASR、Embedding、LLM、動画アップロードから回答までの処理は今回の対象外である。以前の動画E2Eをこの復旧試験と合算しない。小規模な検証時間は本番RTOの根拠にならず、全本番writerのfenceも未実証である。Time TravelはD1のデータを復元するもので、外部副作用や別のDurable Object状態を一括で巻き戻す保証ではない。

本番切り替え、書き込み停止、PRマージは行っていない。既存の性能評価では主要API全体のp95改善が未確認で、NeonはFreeプランのため固定DB費削減も未実証である。性能・予算・復旧範囲の受け入れ基準が満たされるまで本番はNeonを維持する。
