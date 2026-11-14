# 同一Workerからの実シーン検索性能比較

2026年11月15日（JST）、コミット`f60049ba255bf9e5df487808fda63ded9c89245d`の実PostgreSQLアダプターとD1/Vectorizeアダプターを、一時的な非公開Workerの同じリクエスト内から比較した。[集約証跡](evidence/d1-same-worker-scene-performance-2026-11-15.json)。以前のローカルPostgreSQL対リモートD1という配置差を除くための追加検証であり、全APIの性能合格を意味しない。

## 条件と整合性

既存の代表40質問の生成済み1536次元vectorを再利用し、同じvector・動画範囲で存在しない所有者を指定する40件を加えた。モデル呼出しは0回。8バッチそれぞれで通常5件・負例5件を3回ずつ測定し、計240組・480回のrepository検索を実行した。各バッチ内でバックエンドの順序を交互に入れ替えた。

既存Hyperdrive binding経由でNeonへ接続し、`REPEATABLE READ READ ONLY`と`transaction_read_only=on`を確認した。対象78動画・2187sceneについて、本文、vector、metadata、scene/動画の所有者、動画状態、アカウント可視性を含むfingerprintを検証用コピーの元データと照合した。検索用接続も同一snapshotをimportし、最後に保持中のsnapshotのfingerprintと接続状態を再確認した。D1はv3の移行receiptを照合し、既存の全量照合済みコピーを使用した。read replicationは無効のまま。

配置hintは`aws:ap-northeast-1`、8レスポンスすべての`cf-placement`は`remote-NRT`だった。ingress coloは別項目として証跡に残した。hintだけを実行配置の保証とは扱わない。両repositoryは同一Worker invocationで動作する。

## 結果

通常120組の上位集合はすべて一致し、両側2220hitがすべて重なった。完全順位一致は通常105/120組、負例を含め225/240組。負例120組は両側とも空であり、空結果を検索品質の完全一致率へ加算しない。別途行った実サービスの偽metadata・失効アカウント試験は[セキュリティ記録](d1-langchain-security-review.md)にある。

以下は各バッチの**通常検索15回**のrepository時間（ms）。接続初期化、snapshot/data照合、Embedding、HTTP API、LLM回答を除く。個々の時間列を保存していないため、バッチのpercentileから全件のpooled percentileは算出しない。

| バッチ | PostgreSQL p50 | PostgreSQL p95 | D1＋Vectorize p50 | D1＋Vectorize p95 |
|---|---:|---:|---:|---:|
| 1 | 112 | 272 | 237 | 1907 |
| 2 | 102 | 122 | 250 | 305 |
| 3 | 139 | 305 | 229 | 258 |
| 4 | 137 | 228 | 239 | 262 |
| 5 | 137 | 314 | 235 | 297 |
| 6 | 125 | 206 | 239 | 291 |
| 7 | 132 | 226 | 230 | 239 |
| 8 | 120 | 284 | 239 | 331 |

この条件ではD1＋Vectorizeのp50は全バッチでPostgreSQLより遅く、検索経路の性能改善は実証できなかった。最初のバッチのD1 p95は1907msだったが、原因を切り分けていないためcold startと断定しない。D1本文照合とVectorize検索の内訳を計測することが次の診断対象であり、所有権・revision・physical IDの再照合を省略して高速化しない。

## 境界と後片付け

Workerは公開route・workers.dev・preview URLなし、ランダムな専用名、期限付き、64桁乱数tokenの定数時間比較、入力上限・固定model/dimension・SQL bindを使用した。取得したsource credentialsはローカルへ持ち出していない。source PostgreSQL、D1、Vectorizeへの書込みは行わず、本番アプリの設定も変更していない。試験終了後の`wrangler delete --force`は成功し、一時Workerを削除した。

初回deployはJSTの日付をcompatibility dateへ使い、UTCでは未来の日付だったためAPIが拒否した。Worker不存在をAPIで確認後、既存設定と同じ2026-11-14へ訂正して実施した。失敗したdeployを実測へ含めていない。

これは直列の繰返し試験であり、同時負荷・制御されたcold start・本番全API・動画処理から回答までのE2E・月額予算の合格証跡ではない。性能改善の受入条件は未達のまま保持する。本番D1切替は行っていない。
