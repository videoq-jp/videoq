# レビュー済みmainからの停止・再開operator

`run-cutover-admission.cjs`は、既存の所有者付きdeployment/API制御を呼ぶローカル運用入口である。DB管理者資格情報、SQL、SSM、IAMを扱わず、通常のGitHubリクエストroleへの権限追加も行わない。既存operator identityのAWS metadata権限、GitHubの2つのdeployment workflowのadmission権限、既存Cloudflare tokenを使う。これらの権限を新しく発行するコマンドではない。

## 実行元の確認

tracked/untrackedの変更がないcanonical repository checkoutと、実行するソースのHEAD一致を要求する。GitHubからrepository/ownerの固定ID、public/default-main、現在のmainを読み、ソースがmain自身またはmainの祖先であることをcompare結果とmerge-baseの両方で確認する。保守開始後にmainが進んでも、同じrunに固定したレビュー済みソースで元へ戻せるようにする。未マージのfeature commit、別repo、dirty treeは拒否する。[GitHub compare API](https://docs.github.com/en/rest/commits/commits#compare-two-commits)。

AWS accountは固定の本番accountと照合する。既存run/global owner、固定source、実際にRUNNINGの同じexecution、同じstate-machine definition、前のbuildのnative完了を毎回確認する。保守holdの開始元にあるcanonical-main選択や、既存GitHub-only request clientのguardは変更・偽装しない。CLIはGitHub Actions環境での使用も拒否する。

## 操作

`--action`、32桁hexの`--run`、40桁commitの`--source`だけを受け付ける。API tokenは引数へ渡さず、信頼されたローカル実行のprivate environmentで渡す。各操作は同じsource/runを使い、直列に実行する。

```sh
node .github/scripts/run-cutover-admission.cjs \
  --action freeze-deployments --run <owned-run-id> --source <reviewed-source-sha>
```

| action | 処理 |
|---|---|
| `freeze-deployments` | 接続先の原状を不変保存してから、既存2workflowのadmissionを停止し、実際のrunを照合する |
| `inspect-deployments` | 同じ計画で実際のworkflow状態・実行中runを読む |
| `pause-api` | workflow停止・run排出・接続先不変を確認してAPIを停止し、実503応答を検証する |
| `inspect-api` | 同じ所有者・接続先・計画で実際のAPI設定を読む |
| `restore-api` | DB移行未開始・接続先不変・consumer状態を確認し、元のAPI設定とDB readinessを検証する |
| `restore-deployments` | API/consumerの原状とreadinessを確認し、元々有効だったworkflowだけを再開する |

このCLIはholdの開始/解除、consumerの変更、DB fenceの変更を実行しない。SQSやactivity操作は既存の固定AWS workflowで実施する。書き込み前abortはAPI原状復帰 → consumer原状復帰 → workflow原状復帰 → hold解除の順であり、consumer復帰やhold解除を省略するものではない。

最初の原状記録は、AWS内の同じrunとglobal ownerを条件に原子的に保存する。CF事前読み取りに失敗すればworkflowを変更しない。最初のworkflow変更が失敗しても、元の接続先とworkflow計画が残り、明示的な書き込み前abortへ使える。応答喪失時には同じ記録を読み返す。別sourceや原状の置換は許可しない。

API復帰時は、保存済みconsumer計画があれば実Lambda mappingも照合する。metadataの停止markerだけを最終根拠にしない。DB変更marker、未完了のwriter-fence変更/解除/状態marker、接続先の変化があれば、この書き込み前のツールで再開しない。将来のpost-write handoffを別に実装する。

## 権限と検証範囲

外部プロセスへ渡す環境は用途別の許可listに限定する。Cloudflare tokenはAWS/ghへ、AWS credentialはghへ渡さない。AWS transportはDynamoDB metadataの読み取り/条件付き更新、execution metadata/history、Lambda mappingの読み取りだけを許可する。GitHub transportは固定2workflowの読み取り・enable/disableだけを受け付ける。[Workflow API](https://docs.github.com/en/rest/actions/workflows)。秘密値や原状の全内容を標準出力へ出さない。

これは既存の権限を持つ信頼済みの単独operator向けの入口であり、同じrunへの複数operatorを分散直列化する仕組みではない。既存の所有権・revision・native完了のguardは維持するが、本番の自動coordinatorにはコマンド全体の排他と失敗時の実行状況確認も必要になる。単独のadminによる任意操作を隔離するsandboxとしても扱わない。

実DynamoDB Localの46テスト、Node securityの458テスト、Python 68テストが成功した。追加の4統合ケースは全体の書き込み前pause/abort、原状保存応答喪失、CF事前失敗、接続先/fence drift、最初のworkflow変更失敗からのabortを検証する。GitHub/Cloudflare/Lambda/SFNはmockであり、本番での結合停止を実証したものではない。5つのCLI境界テストはソース由来、account、引数、権限、環境分離を検証する。[証跡](evidence/cutover-admission-operator-2026-11-16.json)。

この入口は完全なmain checkout用で、immutable AWS operator ZIPへは追加しない。IAM変更・機能の有効化・本番停止・本番D1切り替えは行っていない。最終snapshot、writer fence/逆移行、外部副作用の照合、最終候補のE2Eと性能・予算の受け入れも残る。
