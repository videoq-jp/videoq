# 検索評価専用Lambdaの独立構成

このディレクトリは通常の`infra/` state/CDから独立する。既定は有効化フラグfalse・予約同時実行数0。2026-11-15にユーザー承認を受け、作成・合成質問1件の接続確認後、この無効状態へ戻した。具体的な結果と承認範囲は[実行計画](../../docs/operations/search-evaluation-deployment-plan.md)を参照する。

固定イメージは2026-11-24の実配備から取り込んだ `sha256:c2df27104052500f7af2d7ec7d2b2dc1dd4339a85c3d3c2384559c5f7e5832ee` である。今回のTerraform移管でコードや公開versionは変更しない。2026-11-17の再構築試験時、以前のPR #1444イメージがECRから消えていたため更新した。評価handler・Embedding・フェデレーション処理が元のレビュー済み実装と同じであることを確認している。通常workerと自動追従しない。既存workerロールを参照するが、IAM policy・trust・通常本番のLambda関数・SQS・Function URL・schedulerは作成/変更しない。

stateは独立したR2キー `videoq/prod/search-evaluation.tfstate` で共有する。ローカルstateへ戻さない。秘密のtfvarsとsaved planは0700の一時ディレクトリに保存し、GitHub artifactやログへ出さない。[R2の運用手順](../TERRAFORM.md)に従ってバックエンド用認証を渡す。

```sh
umask 077
node infra/bin/terraform-r2.cjs -chdir=infra/search-evaluation init -input=false
node infra/bin/terraform-r2.cjs -chdir=infra/search-evaluation plan -input=false \
  -var-file=/private/evaluation/runtime.tfvars.json \
  -out=/private/evaluation/disabled.tfplan
```

`runtime.tfvars.json`は既存workerの`OPENROUTER_FEDERATION_POLICY_ID`だけを`federation_policy_id`へ写し、`execution_enabled`をfalseとする。既存Environment全体をコピーしない。新規作成の想定はLambdaとロググループの2件、既存更新0件、削除0件。実際のplanの全actionがこの集合と一致することを確認する。

承認後も作成は無効状態から行う。次に有効化の別planを確認し、公開された新しい数値versionでのみ同期invokeする。無効状態のversionは評価クライアントが拒否する。`execution_enabled=true` の有効化は既存versionを書き換えず新versionを公開する。無効時は不要なversionを公開しない。検証後は予約同時実行数0へ戻して、すべてのversionへの呼び出しを止める（環境変数だけの無効化では公開済みversionを停止できない）。state/結果は保管し、関数やログの削除はこの手順に含めない。

operatorは限定したCreateFunction/UpdateFunctionConfiguration/PublishVersion/PutFunctionConcurrency/GetFunctionと、このロールに対するPassRole、およびロググループ管理権限を必要とする。InvokeFunctionは指定の評価関数versionだけに限定する。ここでは権限を新規付与しない。worker roleをローカルでassumeせず、権限不足は正規operatorへ引き継ぐ。

再実行前にECRの指定digestの存在を確認する。過去のLambda versionの存在だけではイメージの取得可能性を保証しない。消失時は、現在利用可能なレビュー済みリリースの処理コードと設定を確認し、明示的にdigestを更新する。通常のworkerデプロイに自動追従させない。
