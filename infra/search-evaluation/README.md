# 検索評価専用Lambdaの独立構成

このディレクトリは通常の`infra/` state/CDから独立する。既定は有効化フラグfalse・予約同時実行数0。2026-11-15にユーザー承認を受け、作成・合成質問1件の接続確認後、この無効状態へ戻した。具体的な結果と承認範囲は[実行計画](../../docs/operations/search-evaluation-deployment-plan.md)を参照する。

固定イメージはmainのPR #1444 (`0fb007e98adf74a4171fb26ffe0b2c57e0ee06c6`)の通常CDで配布済みのdigestである。通常workerと自動追従しない。既存workerロールを参照するが、IAM policy・trust・既存関数・SQS・Function URL・schedulerは作成/変更しない。

state、tfvars、saved planはpolicy IDや実行設定を含む。所有者の0700ディレクトリ内、umask 077で管理し、GitHub artifactやログへ出さない。通常prodのstateや`backend.hcl`をコピーしない。既存の同名関数/ロググループがあれば、新規作成としてapplyせず所有状態を確認する。

```sh
umask 077
export TF_DATA_DIR=/private/evaluation/terraform-data
terraform -chdir=infra/search-evaluation init -input=false
terraform -chdir=infra/search-evaluation validate
terraform -chdir=infra/search-evaluation plan -input=false \
  -state=/private/evaluation/evaluation.tfstate \
  -var-file=/private/evaluation/runtime.tfvars.json \
  -out=/private/evaluation/create-disabled.tfplan
```

`runtime.tfvars.json`は既存workerの`OPENROUTER_FEDERATION_POLICY_ID`だけを`federation_policy_id`へ写し、`execution_enabled`をfalseとする。既存Environment全体をコピーしない。新規作成の想定はLambdaとロググループの2件、既存更新0件、削除0件。実際のplanの全actionがこの集合と一致することを確認する。

承認後も作成は無効状態から行う。次に有効化の別planを確認し、公開された新しい数値versionでのみ同期invokeする。無効状態のversionは評価クライアントが拒否する。有効化は既存versionを書き換えず新versionを公開する。検証後は予約同時実行数0へ戻して、すべてのversionへの呼び出しを止める（環境変数だけの無効化では公開済みversionを停止できない）。state/結果は保管し、関数やログの削除はこの手順に含めない。

operatorは限定したCreateFunction/UpdateFunctionConfiguration/PublishVersion/PutFunctionConcurrency/GetFunctionと、このロールに対するPassRole、およびロググループ管理権限を必要とする。InvokeFunctionは指定の評価関数versionだけに限定する。ここでは権限を新規付与しない。worker roleをローカルでassumeせず、権限不足は正規operatorへ引き継ぐ。
