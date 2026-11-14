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


## 実検索の段階別診断

同じ40質問・40負例を各3回、同じsource fingerprintとread-only snapshot条件で再測定した。実アダプターの検索ロジックは変えず、LangChainが呼ぶVectorize bindingの`query`とDrizzleが実行するD1 statementを透過wrapperで計時した。終了後に専用Workerを削除した。[段階別証跡](evidence/d1-scene-search-stage-timings-2026-11-15.json)。前節の非instrumented試験とは別の診断試行として扱う。

| 通常検索120回 | p50 (ms) | p95 (ms) | p99 (ms) |
|---|---:|---:|---:|
| PostgreSQL repository全体 | 131 | 260 | 308 |
| D1＋Vectorize repository全体 | 235 | 268 | 332 |
| Vectorize binding待機 | 128 | 137 | 217 |
| D1 statement待機 | 108 | 121 | 166 |

今回は480件の個別時間を私有領域へ保存したため、この表は各時間分布から直接percentileを計算した。別分布の段階別percentileを加算して全体percentileを求めない。通常検索では全120回がVectorize query 1回とD1 statement 1回、負例では全120回がVectorize query 1回・D1 statement 0回だった。上位集合は引き続き一致し、負例のhitは0件だった。D1管理情報もread replication無効、primaryの大区分はAPACと確認した。APACから特定都市までを推定しない。

VectorizeとD1の2回のI/O待機が確認されたが、binding時間にはサービスと通信の待ち時間が含まれ、SQL engineだけ・ANN計算だけの時間ではない。また[Cloudflareのtimer仕様](https://developers.cloudflare.com/workers/runtime-apis/performance/)により、配備済みWorkerの時計はI/O後に進む。残差が0msであっても、LangChainやJavaScriptのCPU負荷が0という証明にはならない。

診断用の初回呼出しは空応答に対するクライアントJSON parseで失敗し、HTTP状態を記録できなかったため原因不明の不成立試行として除外した。Workerの削除成功を確認後、応答status/bodyを私有ファイルに先に記録するクライアントへ直して改めて実行した。後者の8バッチはすべてHTTP 200であり、失敗試行を合格扱いしていない。

次の性能診断は、D1のengine時間とbinding待機の比較、配置ごとの違い、全API経路の計測が対象になる。検索metadataのみを認可根拠にしたり、D1の最終再照合を削除したりする変更は行っていない。


## D1単純クエリの追加比較

別の専用Workerで同じread-only source照合を通した後、`SELECT 1 AS value`を10回直列に実行した。全件の結果が1であることを確認し、D1のmetaも記録した。配置レスポンスは`remote-NRT`、全件`served_by_region=APAC`・`served_by_primary=true`だった。D1が返したSQL実行時間は0.0924〜0.146msに対し、Workerが観測したI/O待機は76〜87msだった。[単純クエリ証跡](evidence/d1-constant-query-baseline-2026-11-15.json)。このWorkerも試験後に削除した。

単純クエリではSQL計算以外の待機が大きいことを確認できた。ただし、これは実際のscene/動画/userのjoin queryではなく、実検索のSQL engine時間を測った結果ではない。通信・queue・serviceのどれが何msを占めるかも未分離である。認可の再照合削除やread replicaへの無条件切替を正当化する証拠にはしない。

## シンガポール配置での再測定

[Placement Hintsの公式仕様](https://developers.cloudflare.com/workers/configuration/placement/)を確認し、同じコード・コーパス・40質問/40負例・各3回を`aws:ap-southeast-1`で測定した。全8バッチのレスポンスは`remote-SIN`。snapshot/全対象fingerprintとread-onlyを各回確認し、試験後に専用Workerを削除した。[集約証跡](evidence/d1-singapore-scene-performance-2026-11-15.json)。アプリの配置・DB・index・read replicationの設定は変更していない。

| 通常検索120回 | p50 (ms) | p95 (ms) | p99 (ms) |
|---|---:|---:|---:|
| PostgreSQL repository全体 | 18 | 28 | 32 |
| D1＋Vectorize repository全体 | 255 | 281 | 1007 |
| Vectorize binding待機 | 234 | 257 | 989 |
| D1 statement待機 | 19 | 33 | 43 |

D1単純`SELECT 1`の40回も、Worker待機p50 10ms/p95 16ms、D1報告SQL時間0.0665〜0.2141ms、全件APAC primaryだった。東京配置よりD1待機は短くなったが、Vectorize待機が増え、検索全体の改善は実証できなかった。上位集合は全件一致し、負例は両側空のままだった。

異なる配置の試験は時刻も異なるため、無作為同時A/Bとは扱わない。また、結果からNeon/D1/Vectorizeの物理都市を断定しない。配置hintだけを変更すれば受入条件を満たせるという結論にはならず、認可を削る変更も採用していない。

## Vectorize metadata取得方法の切り分け

実際の`CloudflareVectorizeStore`と同じbinding bridgeを使い、`returnMetadata: all`と`indexed`だけを変えて、40質問/40負例を各3回、順序を交互にして比較した。D1の本文照合はこの診断には含めず、返すのは集計と時間のみ。全8レスポンスは`remote-NRT`で、sourceのread-only snapshot/fingerprintも確認した。試験後に専用Workerを削除した。[診断証跡](evidence/d1-vector-metadata-diagnostic-2026-11-15.json)。

| 通常のVectorize呼出し120回 | p50 (ms) | p95 (ms) | p99 (ms) |
|---|---:|---:|---:|
| `all` | 125 | 154 | 344 |
| `indexed` | 118 | 136 | 296 |

全240組でtop-50 physical ID・順序・scoreは一致し、負例filterの結果は両側空だった。ただし、これは最終的なD1認可結果やRAG回答の品質を測った比較ではない。p50の差は7msで、未達の検索全体の性能改善を実証するものではない。

実indexのmetadata index一覧も読み取りで再確認し、`user_id: String`と`video_id: Number`の2項目だけだった。現在のrepositoryは`scene_id`・`revision`を候補照合に使うため、`indexed`への単純な切替は行わない。診断ではphysical ID/scoreだけを比較できても、アプリで必要なmetadataまで同じという意味ではない。schema追加・既存indexの再構築・アプリの検索方式変更も行っていない。
