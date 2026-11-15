# 認証付きHono/tRPC参照APIの隔離性能比較

2026-11-16 JST。**6種類の参照APIではD1が短縮したが、本番切り替えの性能条件全体は未完了。** [機械可読の証拠](evidence/d1-authenticated-api-performance-2026-11-16.json)に全分位点・件数・制約を記録する。

## 測定対象と隔離

main `6882f06f`（アプリのtreeは`e0cb0a7a`と同一）の実`createApp()`を、2つの専用Workersにそのまま組み込んだ。共通のHono middleware、Better Auth password login、cookie sessionのDB検証、tRPC、Repository、出力schema検証を通す。利用者IDのテスト用headerや認証の差し替えは使用しない。

PostgreSQLは本番Neonを親とする専用のdata/schema branch、D1は既存stagingの専用コピーを使用した。本番の既定branch・password・データは変更していない。新規branchだけに専用roleを作成し、専用Hyperdriveのquery cacheを無効にした。PGコピーのpublic base tablesでRLS有効数は0である。ただし、専用roleは本番API roleと同一権限の再現ではない。

両Workersの配置hintは`aws:ap-northeast-1`、全240リクエストの応答は`remote-NRT`。compatibility dateは両方`2026-11-15`で、本番の`2026-08-20`とは異なる。Workers/Neonの料金プラン変更はしていない。

公開route、workers.dev、preview URLは無効。期限付きの専用gateで列挙した認証・参照pathだけを許可し、サービスbindingで呼び出した。Wrangler remote transportのOrigin制約を避けるため、gate検証後のwrapperがPOSTのOriginを自身のURLから設定した。Better AuthのOrigin/CSRF検査自体は有効のままである。この接続方法をブラウザーのCORS試験とは扱わない。

実R2/LLM/SQS/Vectorizeの資格情報・bindingは付与せず、scheduled handlerも持たせていない。R2の署名生成処理には、同一の動作しない検証用の鍵と`.invalid` endpointを両方に与えた。実メディア取得やLLM呼び出しは行っていない。

## 同一データと事前照合

D1コピーは69テーブル（`sqlite_sequence`込み）・10,228行を投入し、外部キー違反0を確認した。エクスポートSQLを直接再投入すると、作成順序・参照先unique index・大きなcheckpoint BLOBのSQL文長上限に当たった。全schema/indexを先に作成し、参照順にparameterized INSERT、BLOBは`unhex(?)`、50文または1 MiB以下の管理API batchとして投入した。これは隔離試験のコピー手順であり、本番移行ツールの完成を意味しない。

対象ownerの動画73件は追加migration前に全列・主キーが一致した。migration `0019_scene_search_readiness`は、既存のcompleted upsertを再確認待ちに戻す正しい動作をする。そのためコピーの73件は`indexing`となり、最初のAPI比較は不一致として停止した。**D1のready判定や状態を緩めず、PGコピーだけを同じindexing状態へ揃えて**再実行した。この測定はVectorize再同期完了の確認ではない。

コピー内だけで専用username/passwordを対象ownerへ設定し、双方で実ログイン・get-sessionのowner一致を確認した。cookie未送信のstatusCountsは双方401。APIの比較では、動画状態・本文・タグ・ページング・件数等を保持して照合し、署名URLの`X-Amz-Date`と`X-Amz-Signature`だけを比較から除外した。URLのpathやそれ以外のqueryは比較している。preflight 12件と反復240件の計252応答が一致した。

## 結果

6 scenario × 20回 × 2 backend = **240リクエスト**。各roundでPG/D1の先後を入れ替え、並行実行はしない。いずれも事前ログイン・preflight後のwarm測定である。

`Server-Timing`のHono時間はwrapperが`app.fetch`の前後を計測し、認証とhandlerを含む。以下はscenarioごとのp95（ms）。

| Scenario | PostgreSQL | D1 |
|---|---:|---:|
| statusCounts | 415 | 42 |
| list | 494 | 42 |
| listPage2 | 567 | 40 |
| listTitle | 524 | 39 |
| listKeyword | 531 | 44 |
| detail | 431 | 43 |

全scenarioを合わせた各120件のHono p50/p95/p99はPG **459/519/569 ms**、D1 **35/43/45 ms**。remote clientのp50/p95/p99はPG **715/853/1,313 ms**、D1 **293/362/717 ms**。remote clientにはWrangler transportの時間が含まれ、実ブラウザーの画面全体の応答時間ではない。

分位点はnearest-rank。scenario別20標本のp99は最大値であり、本番SLOや長期分布の推定値とはしない。一利用者・73動画・逐次処理の結果であり、cold・同時負荷・大規模tenantには一般化しない。

## 後片付けと本番の状態

今回のWorkers、Durable Objects、Hyperdrive、D1コピーを削除し、管理APIで不在を確認した。既存の本番Hyperdriveとstaging D1は保持した。Neon子branchと専用roleの撤去結果は同じ証拠ファイルへ記録する。

基盤PR #1434はmainへマージされ、main CI、通常CD、DB Maintenance CDが成功した。API/Web/Lambdaの配備後に`/health`・`/ready`が200、3 LambdaのActive/Successful、APIのD1 bindingなし、切り替え用3変数が未設定であることを確認した。**本番はPostgreSQLのままである。**

## 残る受け入れ条件

- [実検索の同一Worker比較](d1-same-worker-scene-performance.md)と[並行取得の不採用試作](d1-parallel-prefetch-diagnostic.md)のRAG性能問題は未解決。この参照APIの改善で置き換えない。
- cold・同時負荷・候補の本番互換runtime/configで主要APIを再確認する。
- 外部OAuth、課金・外部副作用、全量最終同期と照合、アカウント全体の予算判定、本番Neon逆移行実行系とwriter停止の統合を完了する。
- 最終候補の両環境E2Eを固定する。条件を揃えてから最終バックアップ、書き込み停止、切り替えを行う。
