# Neonの管理対象ログインを停止するコマンド

D1への最終移行やNeonへの復旧の前段として、API・Worker・移行・smoke/demo等の書き込みログインを`NOLOGIN`にし、既存接続を終了して実際に0件になったことを確認する。`NOLOGIN`だけでは既存接続を止めた証拠にならない。管理用Node.jsスクリプトであり、アプリの通常処理やオンプレ起動には組み込まない。

専用のローカルPostgreSQL/pgvectorで、実接続と別プロセスのCLIによる3テストが成功した。進行中の未commit INSERTは接続終了でrollbackされ、API・SECURITY DEFINER呼出し用ログインの既存接続と新規接続を止めた。元のパスワードで明示解除後に再接続でき、もともとNOLOGINだった退役roleは有効化しなかった。backup接続は維持し、read-only設定を外してもACLで書き込みを拒否した。専用コンテナ・匿名volume・資格情報ファイルは撤去した。[集計証跡](evidence/neon-login-fence-2026-11-16.json)。本番Neonでは実行していない。

## 対象と停止の範囲

本番targetは固定のdirect Neon endpoint、`neondb`、`videoq_`接頭辞だけを受け付ける。pooler接続は使わず、URLの`sslmode=verify-full`、実TLS socketの証明書認可とhostnameを検証する。現在のsession userとcurrent userが同じ独立した管理者であることも確認する。隔離targetはloopback、`recovery_<32桁hex>` DB名と同じ接頭辞に限定する。

接頭辞に一致する全roleのOID・属性・membershipを操作計画に固定する。有効なLOGINのうちbackup/audit以外を停止対象にし、退役NOLOGIN・権限グループはそのままにする。backup/auditは昇格roleのmembership、table/sequence/schemaの書き込み権限、使用可能なSECURITY DEFINER関数を検査し、未知の書き込み能力があれば拒否する。接頭辞外の非管理者LOGINに同様の書き込み能力が見つかった場合も拒否する。

Neon管理者・providerの昇格identityを止める仕組みではない。roleを変更できる管理者、手動SQL、rotation、DB migration、backup以外の保守操作は、外側の既存AWS保守global lockと停止手順で排他する必要がある。`SET ROLE`可能な管理者を、API用LOGINの停止だけで制限したとは扱わない。

LOGIN属性はcluster単位であり、同じroleの他DBへの新規接続にも影響する。他DBで対象roleの接続が既にある場合は操作を拒否し、勝手に切断しない。準備済み2PC transactionは接続切断後も残るため、検出時は拒否し、自動commit/rollbackしない。

## コマンド

0700の管理者専用ディレクトリに、0600のtarget JSONを用意する。本番用の形式は次のとおり。

```json
{
  "purpose": "production",
  "host": "ep-old-truth-a1co51ud.ap-southeast-1.aws.neon.tech",
  "databaseName": "neondb",
  "rolePrefix": "videoq_"
}
```

`VIDEOQ_FENCE_ADMIN_DATABASE_URL`には、このtargetへ直接接続する管理者URLを、信頼された管理実行環境内で渡す。URL・パスワードをコマンド引数、target JSON、state、ログへ書かない。通常のmigration/backup/GitHubロールへDB管理者SSM権限を追加しない。

```sh
npm run db:d1:postgres-login-fence --workspace @videoq/api -- \
  --mode prepare --target /private/operator/target.json \
  --state /private/operator/neon-fence.json
npm run db:d1:postgres-login-fence --workspace @videoq/api -- \
  --mode inspect --state /private/operator/neon-fence.json
```

prepareはDBを変更せず、既存stateを上書きしない。private stateは操作前のLOGIN属性・role identity・membershipを持ち、パスワードは含まない。roleが追加・再作成・変更された場合は同じ計画を再利用して解除せず、停止を維持して差分を調査する。計画外のcredential rotationを実行しない。

API・OAuth callback・webhook・cron・キュー・Lambdaを停止/drainし、保守global lockを保持してからinstallする。

```sh
VIDEOQ_MIGRATION_UPSTREAM_STOPPED=1 \
  npm run db:d1:postgres-login-fence --workspace @videoq/api -- \
  --mode install --state /private/operator/neon-fence.json \
  --confirm-database neondb
```

この環境変数は呼出し側の停止確認であり、API停止やAWS lock取得を実行・証明しない。コマンドはrole属性変更をtransactionで確定後、対象DB内の既存接続（active transactionを含む）を`pg_terminate_backend(pid, timeout)`で終了し、LOGIN無効と接続0件を再照合する。切断できない接続・未識別の接続・準備済みtransaction等が残れば完了としない。失敗時もNOLOGINを勝手に戻さず、同じstateで検証・再試行する。drainせずに実行すると、進行中のtransactionはrollbackされ得るため、業務・queueの再試行整合性は別途確認する。

snapshot/復旧の全量照合が済むまで上流停止を維持する。解除は明示的に行う。

```sh
VIDEOQ_MIGRATION_UPSTREAM_STOPPED=1 \
  npm run db:d1:postgres-login-fence --workspace @videoq/api -- \
  --mode release --state /private/operator/neon-fence.json \
  --confirm-database neondb
```

解除は保存計画で元LOGINだった書き込みroleだけをLOGINにする。password・権限・membership・有効期限・退役NOLOGIN roleは変更しない。D1が書き込みを受けた後に、Neonを単にLOGINへ戻して接続を切り替えることはしない。先にD1側の停止と、D1変更の反映・整合性照合・外部状態の検証を行う。

## 現在の実行境界

このコマンドは現在のAWS保守brokerに登録されていない。本番で使う前に、既存のmainレビュー境界・固定source bundle・global lock・管理者credential隔離を維持する専用operationへ統合し、その経路を隔離検証する必要がある。現段階で本番全writer停止や本番逆移行CLIが完成したとは扱わない。

通常のPG付きCIは主要なrole/接続/CLIを検証する。専用ローカル試験では`max_prepared_transactions=8`と`PERSISTENCE_TEST_PREPARED_TRANSACTIONS=1`を指定し、prepared transactionの拒否も実証した。設定なしの通常CIでこの追加分岐まで実行したとは扱わない。

```sh
# PERSISTENCE_TEST_DATABASE_URL はloopbackの専用PGサーバー
npx --no-install vitest run test/persistence/postgres-login-fence.integration.test.ts
```

[PostgreSQL ALTER ROLE](https://www.postgresql.org/docs/17/sql-alterrole.html)、[接続終了関数](https://www.postgresql.org/docs/17/functions-admin.html#FUNCTIONS-ADMIN-SIGNAL)を参照。`pg_terminate_backend(pid)`のsignal送信成功だけを、終了確認と読み替えない。
