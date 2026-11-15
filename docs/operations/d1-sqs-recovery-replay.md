# 実SQSを残したDB復旧と再配送の隔離検証

2026-11-15。専用の実AWS SQS Standardキュー、ローカルworkerd D1、専用PostgreSQL/pgvectorを使い、DB復旧を挟む再配送を検証した。結果は成功。本番キュー・Lambda・DBは変更していない。[集計証跡](evidence/d1-sqs-recovery-replay-2026-11-15.json)。

## 手順と結果

1. 新規の専用キューを作成し、操作名とランダムnonceのタグで所有権を固定した。キューは東京リージョン、SQS管理の暗号化、短い保持期間を指定し、アプリやLambdaへバインドしていない。
2. 合成ジョブ2件を投入した。片方はD1で既にcompleted、もう片方は実SQSで受信後にD1のJobRepositoryでclaimし、停止を表すfailed状態にした。メッセージはACKしなかった。
3. 唯一の検証consumerを停止した状態で、D1の共通56テーブルと採番情報を取得し、実復旧処理でPostgreSQLへ反映した。
4. 保持していたメッセージを`ChangeMessageVisibility(0)`で再び取得可能にし、PostgreSQLの実JobRepositoryでconsumerを再開した。failedジョブは新しいリースで1回だけclaimでき、復旧前の古いリースでは完了できなかった。completedジョブは再claimされなかった。
5. 再試行ジョブをPGで完了させた後、SQSメッセージのACKを故意に省略して再度可視化した。再取得時のReceiveCountは3以上となり、JobRepositoryはcompletedを返した。完了済み業務を新たにclaimすることなくACKした。
6. 同じ完了済みジョブをさらに12メッセージとして投入し、取得バッチ内では並行claimした。全12件がcompletedで、新しいclaimは0件だった。送信した14個のMessageIdをすべて再取得・ACKし、最後のlong pollも空だった。PGのattemptsは元completedが1、再試行したジョブが2のままだった。

Standardキューの[at-least-once配信](https://docs.aws.amazon.com/AWSSimpleQueueService/latest/SQSDeveloperGuide/standard-queues-at-least-once-delivery.html)と[visibility timeout](https://docs.aws.amazon.com/AWSSimpleQueueService/latest/SQSDeveloperGuide/sqs-visibility-timeout.html)を前提に、ACK欠落と明示的重複を再現した。自然発生する全重複の網羅やexactly-once配信を主張するものではない。

## 実装と再実行

`test/persistence/sqs-d1-recovery.remote.integration.test.ts`は明示的なopt-in試験である。SQSへの接続だけをboto3の小さなbridgeへ委譲し、D1とPGの業務操作はアプリの実Repositoryと実復旧処理を呼ぶ。bridgeは許可したリージョン・キュー名・URL・所有タグとnonceを確認し、合成ジョブ以外の送信を拒否する。AWSエラー・receipt handle・資格情報をエラーログへ出さない。

実行前に新規の空キューを用意し、所有者専用の設定ファイル（0600）に`region`、`account`、`queueName`、`queueUrl`、`nonce`、2時間以内の`expiresAt`を指定する。queueNameは`videoq-recovery-<8桁日付>-<8桁hex>`、nonceは32桁hex、タグは`videoq-operation=isolated-sqs-recovery`と`videoq-nonce=<nonce>`である。資格情報はファイルへ書かず、boto3の通常の認証経路を利用する。

```sh
cd apps/api
# PERSISTENCE_TEST_DATABASE_URL: loopback上の専用PG/pgvector
# PERSISTENCE_SQS_REPLAY_CONFIG: 所有者専用のキュー設定ファイル
# PERSISTENCE_REPLAY_PYTHON: boto3入りPythonのパス
npx --no-install vitest run test/persistence/sqs-d1-recovery.remote.integration.test.ts
```

設定がない通常CIでは試験をskipする。今回の実AWS実行は別の証跡であり、CIのskipを成功と数えない。試験はキューを作成・削除せず、管理者が終了時に専用キューを削除する。今回の実行では所有タグを再照合して削除し、AWS APIで不存在を確認した。専用PGコンテナ・匿名ボリューム・一時DB接続情報も撤去した。

## 限界と受け入れ判断

consumerは検証スクリプトであり、Lambda、Python Worker、HTTP内部認証、音声認識、Embedding、モデル呼出し、課金、Stripeを実行していない。これは**実SQS再配送とDB復旧後のJobRepository継続**の検証であり、Lambda event-source mappingの停止・再開や外部副作用の冪等性の受け入れではない。以前の実SQS/Lambda動画E2Eと、今回のDB復旧試験を一つの全体E2Eとして合算しない。

合成ジョブ2件での試験時間を本番RTOとみなさない。キューを残して復旧した間の業務書き込み元は検証スクリプトだけであり、本番の全writer fenceの実証でもない。本番D1切替・マージの停止条件は維持する。

性能については既存の[段階別診断](d1-same-worker-scene-performance.md)を再確認した。東京近傍の通常検索p95は全体268ms、Vectorize binding待機137ms、D1 statement待機121msで、シンガポール配置はD1待機が短くなってもVectorize待機が増えた。異なる分布のpercentileを加算しない。metadataの`all`→`indexed`変更も検索全体の改善を証明せず、必要なscene/revision検証を欠くため採用していない。今回、新たな性能計測や認可省略による高速化は行っていない。

後続の[実Lambda・署名付きHono API・D1 Time Travel復旧](d1-lambda-time-travel-recovery.md)では、専用mappingの停止・再開を別途実証した。そちらはD1内の復旧であり、本試験のD1→PostgreSQL切り戻しとは検証範囲が異なる。
