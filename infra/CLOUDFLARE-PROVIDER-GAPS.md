# Cloudflare公式Terraform Providerの制約とVideoQの対応

確認日: 2026-11-24。対象はVideoQで固定している `cloudflare/cloudflare = 5.29.0`。
Cloudflare全製品の未対応API一覧ではなく、この本番構成に関係する制約を記録する。

| 対象 | 公式Providerの制約 | 現在の管理方法 |
|---|---|---|
| Vectorize index（本番・評価の2件） | 対応するresourceがない | `Mastercard/restapi` 3.0.0でCloudflare APIをTerraformから管理。既存indexを取り込み、再作成を禁止 |
| Vectorize metadata index（5件） | 対応するresourceがない | 同じREST Providerで管理。型の正規化と検証を行い、意図しない型変更・削除を禁止 |
| 既存Queue consumer（2件） | `cloudflare_queue_consumer`は作成・更新できるが、5.29.0はimport非対応 | REST Providerで既存consumerを取り込み。APIの`script`応答を`script_name`に正規化して差分を検知 |
| Cronのドリフト検知 | resourceはあるが、`schedules`に`no_refresh`が指定され、外部変更を通常refreshで読み戻せない | 定義・適用は公式Provider。別の読み取り専用API照合をTerraform external data/preconditionで必須化 |
| Terraform Searchによる一覧発見 | 5.29.0のschemaには`list_resource_schemas`がない | 公式APIで一覧取得し、対応するresourceを通常のimportで取り込み |
| Email Routingの有効状態の指定 | settings resourceの`enabled`と`status`は読み取り専用。外部で無効化されても通常の更新差分にならない | settingsと確認済み転送先を公式Providerへ取り込み、postconditionで有効・ready・転送先確認済みを検証。外部で無効化された場合は処理を止め、復旧方法をレビューする |

これらの代替もTerraformのstateに記録される。REST ProviderはCloudflare公式Providerではないため、公式resource/importが対応した際は、既存リソースを再作成せずstateの所有権を移す。

## Providerの未対応とは区別するもの

- D1の行、Vectorizeのベクトル、R2のメディア、Durable ObjectsのSQLite内容はアプリケーションデータ。Terraformは保存先やbindingを管理する。
- Durable Objectのnamespace IDはWorkerのclass/migrationからCloudflareが生成する。既存4 namespaceはreleaseのbindingでIDを維持する。
- Worker secretsは公式Worker versionの`inherit`で継承する。値を読んでstateへ保存しない。外部ローテーション後は実際のversion/deployment IDとTerraformの所有権を照合する。
- Cloudflareが作成する読み取り専用DNS（Workers custom domainやEmail Routingの内部レコード）は元の機能を管理し、DNS resourceとして二重所有しない。
- API tokenの初期発行、アカウント権限、GitHub Secretの値は認証情報の管理元で保持する。
- PagesはVideoQ本番では使っていない。WebとDocsはWorkersで配信している。共有アカウント内の別プロジェクトのPagesは対象外。

## 公式ツールを使う

Terraformの調査にはHashiCorp公式 [terraform-mcp-server](https://github.com/hashicorp/terraform-mcp-server)、実装には公式 [agent-skills](https://github.com/hashicorp/agent-skills) の `terraform-style-guide`、`terraform-search-import`、必要なテストでは `terraform-test` を使用する。

本作業ではMCP Server 1.4.1の公式イメージをdigest固定し、`registry` toolsetで起動した。`initialize`、`tools/list`、`search_provider_docs`、`get_provider_details`を実行し、Cloudflare 5.29.0の資料を取得した。MCPはドキュメント調査に使い、本番applyはレビュー済みTerraform実行経路で行う。

## 根拠

- [Cloudflare Provider 5.29.0 resources](https://github.com/cloudflare/terraform-provider-cloudflare/tree/v5.29.0/docs/resources)
- [Queue consumer import制約](https://github.com/cloudflare/terraform-provider-cloudflare/blob/v5.29.0/docs/resources/queue_consumer.md#import)
- [Cron modelのno_refresh指定](https://github.com/cloudflare/terraform-provider-cloudflare/blob/v5.29.0/internal/services/workers_cron_trigger/model.go)
- [Email Routing settingsの読み取り専用属性](https://github.com/cloudflare/terraform-provider-cloudflare/blob/v5.29.0/docs/resources/email_routing_settings.md)
- ローカルの固定Providerで `terraform providers schema -json` を確認: Vectorize resource / list resourceなし。
