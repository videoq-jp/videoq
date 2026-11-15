# D1 Worker内部APIクライアントの展開

この変更はWorkerの永続化クライアントを追加する。Hono側のD1実装、実行環境の設定、
キュー接続、IAM、federation policy、モデル、ストレージ設定を変更しない。
統合中のAPI実装はPR #1434で管理し、このクライアントだけの配布をD1移行完了とは扱わない。

## Backend選択

| 設定 | 動作 |
| --- | --- |
| edition/backendとも未指定 | 既存PostgreSQL |
| `onprem` / `postgres` | PostgreSQL。Cloudflare接続不要 |
| `cloud`またはbackendが`d1` | 署名付きHono業務API。直接PostgreSQL接続を拒否 |
| `cloud` / `postgres` | `MIGRATION_ALLOW_CLOUD_POSTGRES=true`が必要 |
| `onprem` / `d1`、未知の値 | 設定エラー |

2026-11-15の読取り確認では、既存media/search/account Lambdaの上記3設定はすべて未指定だった。
これは確認時点の状態であり、配布直前にも対象の設定を再確認する。
新しいイメージを配布しても、その既定値では既存PostgreSQLを使う。
既存のPostgreSQL migration、依存lockfile、Lambda handler入口は維持する。

## 内部API契約

- originはパス・query・userinfoのないHTTPS origin。秘密値は32 UTF-8 bytes以上。
- `videoq-worker-v1`、timestamp、POST、origin、path、送信するJSONの正確なbytesをHMAC-SHA256で署名する。
- 接続先のredirectへ署名を転送しない。入力・応答サイズとHTTP timeoutを制限する。
- claim/heartbeat/完了/失敗、利用枠、文字起こしcheckpoint、scene staging/publication、
  視覚解析の不変object版、再索引のページ、account削除の業務操作だけを公開する。
- D1選択時はDB secretをbootstrapせず、SQLへの暗黙のfallbackを行わない。
- secret bootstrap後、空batchを含む配送の受付前にAPI originと共有秘密値を検査する。
  不足したD1設定で正常な空batch応答を返さない。
- source revision・file・leaseの最終判定はHono側で行う。API応答が不正・欠損なら成功と推定しない。
- 索引の`pending`は再Embeddingせず再試行する。API側ではprovider受付と検索反映を分け、
  全sceneの反映確認後に既存の完了ジョブをOutboxから配送する。
- 生のprovider/DB診断やジョブpayloadを通常ログ・失敗記録にコピーしない。

## 配布と検証

1. Worker変更をmainでレビューし、通常CI/CDで生成した不変image digestを確定する。
   [既存の保守運用の信頼境界](../../infra/db-maintenance/README.md)と同様に、配布コードのレビューを実行権限の境界とする。
   worker roleはDB用SSM/KMS・SQSの権限も持つ。
   環境変数を省略しても権限は剥奪されない。未レビューのブランチコードをこのroleで実行しない。
2. main配布時は既存のbackend設定を維持する。既存3関数やprod queueをD1試験用へ流用しない。
3. 別途照合した計画で、試験専用のD1/API・ストレージ・キュー・関数を用意する。
   既存roleのローカルassume、production credentialsの持出し、federation trustの拡張を試験の代用にしない。
4. 対応するAPI/schemaを配備する。scene readinessを使う版では、metadata indexの処理完了、
   旧同期処理の停止、D1 migration、新API配備の順序を守る。
5. 専用関数にだけ`cloud` / `d1`、HTTPS origin、試験専用の共有秘密値を設定する。
   秘密値をコマンド引数・通常vars・成果物へ含めない。モデルとEmbedding設定は既存の構成と照合する。
6. 同じ公開済み数値versionとdigestで、upload→文字起こし→索引反映→質問応答まで検証する。
   重複配送、lease競合、途中失敗・再開、字幕編集、削除、利用枠の二重加算防止も含める。
   モックや部分API試験をこの実環境の合格に読み替えない。
7. 成否にかかわらず専用配送・起動を停止し、試験resourceと一時秘密値の残存を別の読取りで確認する。

このPRに実環境の作成・有効化や本番D1切替は含まれない。
本番D1が書込みを受け付けた後は、PostgreSQLへの接続設定だけを戻してはならない。
書込みを停止し、D1側の変更を保存して再適用または明示的な復旧を行う。

## 検証範囲

Workerの既存PostgreSQL試験と、内部API署名・backend拒否・lease・quota・checkpoint・
不変object版・scene publicationの試験を同じsuiteで実行する。
依存やモデルを変更したり、オンプレミスへCloudflare接続を要求したりしない。
実Lambda/SQS/モデルを含むD1の全体E2Eと、本番切替の受入判定は後続の実行結果を必要とする。

ローカル検証ではPython 3.12.12と隔離したPostgreSQL 17.11でWorker全体を実行し、
763 passed / 1 skippedとなった。署名・設定・ジョブなどの対象79テストも成功した。
試験用DB containerは削除後の独立した読取りでも残存しないことを確認した。
CIの別Python版、実Lambda/SQS/モデルの動作をこの結果だけで保証するものではない。

既存CDは `apps/api/**` の試験変更でもAPI配布を選択し、`docs/**` の変更で
ドキュメント配布も選択する。このPRの通常CD対象はWorker 3関数・API・ドキュメントである。
API本体と本番wrangler設定は比較元mainと一致する。DB migrationやD1有効化は含まない。
