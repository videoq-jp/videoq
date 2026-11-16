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

## 復旧トランザクション中の停止維持（2026-11-16）

`withPostgresLoginFenceTransaction`を追加した。専用の管理者connectionを作成し、targetをURL・DB・実接続で照合した上で、共通キーのtransaction-scoped advisory lockを保持する。既存のinstall/releaseも同じキーを非待機で取得し、別の復旧transactionが保持していれば、roleを変更せず拒否する。復旧処理後にwriterのLOGIN・接続・role/membershipを再検証してからcommitする。失敗時はDBのtransactionをrollbackし、LOGINは自動で戻さない。専用connectionは常に閉じる。

role変更の最終確認にはRead Committedを使用する。同じ古いsnapshotに固定して最後の確認を済ませるのではなく、別管理者が途中でcommitしたrole変更を検出するためである。実PGで新しいroleを別connectionから作成し、復旧側の書き込みがrollbackされることを確認した。advisory lockはこの手順に従う操作間の排他であり、別管理者の任意SQLを禁止するものではない。[PostgreSQL advisory locks](https://www.postgresql.org/docs/17/functions-admin.html#FUNCTIONS-ADVISORY-LOCKS)、[Read Committed](https://www.postgresql.org/docs/17/transaction-iso.html#XACT-READ-COMMITTED)を参照。

この関数はレビュー済みの固定operator codeだけに使う。callbackは自身でBEGIN/COMMIT/ROLLBACKを実行せず、外部副作用も含めない。transaction IDの変化は失敗として検出するが、任意callbackや管理者SQLを隔離するsandboxではなく、先にcommitされた処理を取り消せるという保証でもない。AWSのglobal lockと上流停止は別に取得・検証・維持する必要がある。

既存の`restorePostwriteSnapshot`へ`loginFence`を渡すと、この共通transaction内で実際の全テーブル復元・値照合・採番更新を行う。この接続は引き続きloopbackの`recovery_<32hex>`復旧DB、`public`/`chat_memory`、同じplanのhost/DBに限定し、戻り値も`productionSafe:false`のままとした。本番のガードを削除したり、上流停止のbooleanだけで本番を許可したりしていない。

専用PG/pgvectorとローカルD1の4ファイル14テスト、既存の復旧単体21テスト、型検査・lintが成功した。14件には同時解除・再停止・二重復旧の拒否、失敗rollback、role drift、実D1行の復元、D1で削除済みIDの採番床、復旧途中のUNIQUE違反による既存行保持、認証継続・fingerprintの回帰確認を含む。専用コンテナ・匿名volume・credential fileは撤去した。[集計証跡](evidence/neon-fenced-transaction-2026-11-16.json)。

本番Neonでは未実行。AWSの固定bundle・global lock・管理者credential wrapperへの統合、本番の最終snapshot/逆移行CLI、外部状態の照合は依然として残件である。

## AWS内の読み取り専用準備経路（2026-11-16）

既存maintenance brokerへ`audit`の固定`inspection: postgres-login-fence`を追加した。通常auditの意味は変えず、global lock内の固定rotation jobで、immutable operator ZIPに含まれるprepareコマンドだけを実行する。[AWS保守の説明](https://github.com/videoq-jp/videoq/blob/main/infra/db-maintenance/README.md#read-only-managed-login-fence-preparation)を参照。

DB-admin SecureStringはAWS親だけが取得し、子へ渡すのは固定target用のDB接続と許可した環境だけとした。AWS/OIDCや既存のNode/PG設定は継承せず、読み取り専用のPGOPTIONSを明示する。管理者自身による任意SQLを隔離するsandboxではなく、mainレビュー境界は維持する。計画は子のprivate fileから同じschemaで検証し、AWSのrun recordへ条件付きで保存・hash照合する。応答喪失・既存計画の再利用・破損では、計画を上書きしない。

配布ZIP＋実PGの隔離試験、AWS親の境界4テスト、Nodeのデプロイポリシー389テスト、Python 156テスト（7 skip）、infra 57テストが成功した。Step Functions定義はAWSの検証APIで`OK`、diagnostics 0。専用コンテナと資格情報ファイルは撤去した。[集計証拠](evidence/aws-neon-fence-audit-2026-11-16.json)。この実装時点では本番操作は未実行だった。その後の読み取り専用監査は、下記のとおり成功した。NOLOGIN操作・復旧・切り替えは未実行である。

この準備の成功後もglobal lockを保持し続けるわけではなく、active fenceの永続leaseでもない。本番の停止・drain、固定sourceによるinstall/inspect/release、逆移行と外部状態の照合を一連の保守経路へ結合する作業は残る。


## 本番での読み取り専用監査と原状保存

[本番のmainワークフロー 43779197615](https://github.com/videoq-jp/videoq/actions/runs/43779197615)で固定の読み取り専用監査が成功した。管理対象28 role、そのうち元のLOGIN有効7 roleの計画をAWS内へ保存し、対象・hash・配布コードを照合した。監査後の公開readinessも成功した。管理者資格情報はAWSから持ち出していない。[集計証拠](evidence/production-postgres-fence-audit-2026-11-16.json)。これはログイン停止ではなく、監査終了後もglobal lockを保持する処理ではない。

保守hold内で最初に成功したactivity観測では、停止前の元のrole計画・hash・最初のbuild/actionを同じrunへ原子的に固定する。再観測で元のLOGIN状態を上書きせず、catalogが変われば拒否する。[詳細](postgres-cutover-activity.md#immutable-pre-fence-state)。この原状保存もinstall意図・drain・停止解除・本番逆移行の実装を代替しない。後続の変更処理は同じholdとこの原本へ結び付ける必要がある。
