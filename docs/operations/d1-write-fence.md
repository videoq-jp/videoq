# D1の行書き込みを止める管理コマンド

本番切り戻し・一貫snapshotの準備として、D1のアプリテーブルとmigration ledgerへINSERT/UPDATE/DELETEの拒否トリガーを設定する。APIを止めた後に残る旧Worker・処理中のリクエストを補うDB側の防御である。通常アプリや共有ドメインには変更せず、管理スクリプト内に実装する。

2026-11-16、現行20マイグレーションを適用した専用の実D1で検証した。68テーブル・204トリガーを照合し、独立したCloudflare管理APIからの更新・削除・INSERT OR REPLACE・新規登録4件を拒否した。全69テーブル（sqlite_sequenceを含む）の値ハッシュは設定前と停止中2回で一致し、foreign_key_checkは空だった。明示的な解除後は更新と削除ができた。専用D1の不存在と公開管理WorkerがないことをAPIで確認した。[集計証跡](evidence/d1-write-fence-2026-11-16.json)。

## 対象の固定と実行

管理者専用0700ディレクトリに、次の形式の0600 target JSONを用意する。秘密値は含めない。アカウントはVideoQの固定アカウントだけを受け付け、DB IDと名前は、コマンドが操作前にCloudflare管理情報と照合する。接続configはこの1 DBだけを含む一時ファイルとして生成し、R2・Vectorize・Hyperdrive・本番secret・公開routeを持たせない。

```json
{
  "version": 1,
  "accountId": "12daec56fdba43f677f2766ee26a5a39",
  "databaseId": "<管理情報で照合したDB UUID>",
  "databaseName": "<同じDBのvideoq-接頭辞付き名前>",
  "purpose": "isolated-rehearsal"
}
```

本番ではpurposeを`production`にする。purposeは監査用の区別であり、権限を制限する仕組みではない。Wranglerの管理認証を使い、秘密値を引数・target JSON・ログへ出さない。

```sh
npm run db:d1:write-fence --workspace @videoq/api -- \
  --mode prepare --target /private/operator/target.json \
  --state /private/operator/fence-state.json
npm run db:d1:write-fence --workspace @videoq/api -- \
  --mode inspect --state /private/operator/fence-state.json
```

prepareは読み取りだけで、現行manifestの全テーブル、全migrationファイル名とremote ledgerの一致を確認し、DB ID・operation ID・全table一覧・基準DDLハッシュをstateへ保存する。既存stateは上書きしない。最初のprepareが失敗して空stateが残った場合も、勝手に再作成しない。prepareが読み取りのみであることと対象schemaを確認して別のstate名でやり直す。既にinstallを開始したstateは必ず保全する。

API、OAuth callback、課金webhook、cron、TaskScheduler、SQS/Lambda、手動管理処理、CDによるmigrationを停止/drainしてから、対象UUIDを明示してinstallする。

```sh
VIDEOQ_MIGRATION_UPSTREAM_STOPPED=1 \
  npm run db:d1:write-fence --workspace @videoq/api -- \
  --mode install --state /private/operator/fence-state.json \
  --confirm-database '<stateと独立に照合した対象DB UUID>'
```

この環境変数は運用者の停止確認であり、停止を実行・証明するものではない。コマンドはSQSやAPIを停止しない。DB UUID、state内の対象、現行manifestのhashを再照合する。トリガー名だけでなく、対象tableと拒否SQLの全文、元のtable/index/view/trigger DDLを照合する。別operation、弱めたトリガー、schema driftは拒否する。

20文ずつのbatchで設定し、中断した場合は同じstateで再実行できる。**全DBへの設定は一括原子処理ではない**。`partial`の間はまだ書けるテーブルがあるため、上流停止を維持する。全204個の確認を含む`state=fenced`だけをDB行書き込み停止の確認とし、その後に業務・索引・会話lease等のquiescence、R2/Vectorize整合性を別途検証する。新しい対象schemaでは204という数を固定値にせず、全table数×3とSQL全文を照合する。

解除は上流停止のまま、同じstateを使って明示的に行う。自動timeoutや失敗時finallyで解除しない。

```sh
VIDEOQ_MIGRATION_UPSTREAM_STOPPED=1 \
  npm run db:d1:write-fence --workspace @videoq/api -- \
  --mode release --state /private/operator/fence-state.json \
  --confirm-database '<照合済み対象DB UUID>'
```

解除もbatch単位で、中断中は`partial`となる。全解除とsnapshot/復旧結果の照合が済むまでトラフィックを戻さない。既存stateでreleaseを再実行しても、別operationのトリガーや他のDDLを削除しない。

## 保証しない範囲

これはDBの行操作を拒否するもので、Cloudflare管理権限に対するセキュリティ境界ではない。DROP/ALTER/CREATE、PRAGMA、システムtableの直接操作を禁止せず、管理者はトリガーを削除できる。新tableを追加した場合も、次のinspectがschema driftを検出するだけで、そのDDL自体は阻止しない。CDと管理作業の停止は必要である。

R2、Vectorize、SQS、他のDurable Object、Neonへの書き込みも止めない。Time Travelで設定前のbookmarkへ戻すとこのトリガーも消え得るので、復旧後は上流を止めたまま再検証し、古い`fenced`出力を再利用しない。DDLを含むsnapshotを復旧する場合は、トリガーを勝手に除外したり、fence解除が済んだと推定したりしない。

ローカル7テストは、実migrationを使うD1で事前に準備したSQL・置換・batchの拒否、中断後の再開、不正な対象・入力権限・schema drift・トリガー改変を検証する。実D1試験はこの行書き込み停止とCLIに限り、本番全writer停止、PostgreSQL側fence、本番用逆移行CLIの完成、性能改善、本番切り替えを証明しない。

[D1 batchの公式仕様](https://developers.cloudflare.com/d1/worker-api/d1-database/#batch)、[SQLite triggerとRAISE](https://www.sqlite.org/lang_createtrigger.html)を参照。各batch内の原子性を、全batchをまたぐ原子性と読み替えない。
