# 廃止済みの検索評価Lambda

OpenRouter専用の検索評価Lambdaと専用ロググループを撤去するため、バックエンド定義だけを残しています。推論はWorkers AIへ移行しました。旧Lambdaを有効化・再作成する手順は使用しません。

stateはR2の `videoq/prod/search-evaluation.tfstate` に保持します。削除後も履歴を維持し、他のstateや共有メディアworkerロールは変更しません。操作には `node infra/bin/terraform-r2.cjs -chdir=infra/search-evaluation` を使用します。
