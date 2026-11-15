# D1本文取得とVectorizeの並行化試作

2026-11-16。同じ非公開Worker invocation内で、現行PostgreSQL、現行D1の直列検索、D1の読み取りを並行化した試作を比較した。通常40質問・所有者負例40件を各3回、3方式の順番を巡回させ、計720 repository callを測定した。元のEmbeddingとscopeを再利用し、モデル呼出しは0回。各batchでPG read-only snapshotと元コーパスfingerprintを確認した。[集計証跡](evidence/d1-parallel-prefetch-diagnostic-2026-11-16.json)。

試作は要求ごとに、D1 primaryの一つのSQLでユーザー可視性・動画所有者・完了状態を確認し、対象シーンを上限付きで取得する。同時にVectorizeを検索し、D1が返したscene ID・revision・physical vector IDに一致した候補だけを返す。要求間のcacheは使わない。2,500行・推定2MiBを超えるscopeでは現行方式に戻す設計とし、今回の最大は1,336行・推定約1.89MBで、fallbackは0回だった。

通常検索120回の時間（ms）:

| 方式 | p50 | p95 | p99 |
|---|---:|---:|---:|
| PostgreSQL | 130 | 223 | 299 |
| 現行D1直列 | 244 | 305 | 357 |
| D1並行取得試作 | 229 | 477 | 611 |

配置レスポンスは全8batchが`remote-NRT`。通常検索の上位集合は両D1方式とも120/120でPGと一致し、所有者負例は全件空だった。ただし完全順位一致は各105/120であり、関連性Recallの完全一致を証明するものではない。

試作はp50が15ms短縮したが、p95/p99が悪化し、PostgreSQLよりも遅かった。多くの本文を先に取得する方式を性能改善として採用しない。試作は私有領域の診断コードに留め、アプリの検索実装は変更していない。認可やD1での照合を省略する変更も行っていない。

これはrepository内部の診断であり、認証・HTTP API・Embedding・LLM・同時負荷・制御したcold startは測定していない。並行処理のstage待機時間は重なるため、SQLとVectorizeのpercentileを加算しない。試作の並行更新・攻撃入力を含む本番契約を受け入れた結果でもない。一時Workerは削除し、管理APIで不存在を確認し、ローカルの専用Bearer tokenも削除した。DBとVectorizeは読み取りだけで、本番設定を変更していない。
