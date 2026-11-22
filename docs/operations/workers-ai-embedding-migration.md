# Workers AI埋め込み移行

2026-11-22。生成経路は[PR #1597](https://github.com/videoq-jp/videoq/pull/1597)。上流は[JS #12285](https://github.com/langchain-ai/langchainjs/pull/12285)と[Python #103](https://github.com/cloudflare/langchain-cloudflare/pull/103)で、取り込み待ちの間はLangChain OpenAIEmbeddingsからAI bindingへ接続する。

## ロボットビジョン講座での比較

同じ16動画・420字幕シーンを使用し、本文・シーン境界を変更せずに`@cf/google/embeddinggemma-2`で再生成した。検索語は`task: search result | query: `、文書は`title: none | text: `を使用した。現行の1536次元ベクトルは生成し直さず、配信中のVectorizeから全420件を取得し、scene ID・revisionをD1と照合した。

検索結果を見る前に12テーマ・24質問と根拠scene、4件の範囲外診断質問を私有ファイルへ固定した。ラベルはAIが字幕本文を確認して選んだ根拠場面で、人手レビュー済みでも網羅的な正解集合でもない。一般的なRecallではなく、既知の根拠場面に対する取得率と順位の回帰を測る。

| 指標 | 現行OpenAI | EmbeddingGemma 2 |
|---|---:|---:|
| 根拠場面Hit@1 | 8/24 | 7/24 |
| 根拠場面Hit@5 | 15/24 | 16/24 |
| 根拠場面Hit@20 | 19/24 | 21/24 |
| 根拠場面MRR@20 | 0.47117 | 0.47805 |
| 3回の検索で順位が安定した質問 | 24/24 | 24/24 |

事前の相対基準はHit@5差−0.02以上、Hit@20差0以上、MRR差−0.02以上、所有者・講座範囲の越境0件。すべて満たした。上位1件の精度は下がっており、全質問・全講座での品質向上を意味しない。

同一ローカルクライアントからVectorize APIを交互に呼び、質問ごとに各3回測定した検索APIのp50は現行205.7ms／候補186.1ms、p95は238.5ms／236.6msだった。埋め込み生成、D1 hydration、回答生成を含まないため、アプリ全体の遅延比較とは扱わない。両モデルともスコア分布が違う。現在の検索は固定top-kであり、この小標本だけから共通の類似度しきい値を追加しない。

範囲外の4質問は根拠場面の取得率へ混ぜず、診断用とした。所有者不一致の負例56検索はすべて0件だった。通常・診断検索でも所有者と講座のmetadata範囲外への漏れは0件。

[集計結果](../validation/workers-ai-embedding-comparison-2026-11-22.json)には本文・所有者ID・個別scene IDを含めていない。raw入力・ベクトル・ラベル・個別順位は0700ディレクトリ／0600ファイルで私有保存した。

## 再計算

同じ形式の凍結済みラベルと検索結果から、モデルを呼ばずに採点できる。

```sh
node .github/scripts/embedding-migration-metrics.cjs /private/labels.json /private/retrieval-results.json > /private/scored-report.json
node --test .github/scripts/embedding-migration-metrics.test.cjs
```

欠けた反復・重複結果・不正スコアを拒否し、反復数を独立した質問数として数えない。

## 全講座への展開

現行D1の全80動画・2,190字幕シーンを同じ本文・境界で768次元へ再生成し、既存のsource revisionによる競合検出、staging、公開処理を経由して配信した。全件のVectorize読み戻しでベクトル・所有者・動画・revisionを照合し、公開headの準備完了と未処理タスク0件を確認した。切り替え時点では旧1536次元の字幕データとインデックスを保持し、未使用だった旧768次元データも事前にバックアップした。2026-11-22に本番の検索・取り込み設定を同じWorkers AIモデル・profileへ切り替え、キューを再開した。

検索側と字幕登録側は同じモデル・profile・入力形式へそろえて切り替える。全件の配信、権限境界、実検索・字幕登録の確認が済むまで本番切り替え完了とは扱わない。旧インデックスは後述の整理で削除済み。

旧1536次元への二重書き込みは行っていない。旧インデックスへの切り戻し手順は廃止した。

## 本番切り替えの確認

[PR #1597](https://github.com/videoq-jp/videoq/pull/1597)と[PR #1598](https://github.com/videoq-jp/videoq/pull/1598)は統合CIを通過してmainへマージ済み。切り替え中は3つのSQS consumerを停止し、処理中メッセージ0件を確認してからワーカーイメージを更新した。APIと3ワーカーのモデル設定をそろえ、実機確認後に元どおり有効化した。他のAPIバインディング・シークレット参照とワーカー環境変数は保持している。

切り替え時にはAPIバージョン `f527f532-b5cb-4400-b981-dcf21b9aa165` の100%配信を確認した。3ワーカーには同じレビュー済みARM64イメージ `sha256:342ac10fd37976cae380af5928291462b51c8256a14be71705763d4263c6bcb0` を配備した。Pythonイメージから本番の署名付き内部APIを通し、文書用・検索語用とも1件／768次元の生成を確認した。health・readyはともに200。

講座画面で新しい検索を実行し、「シーン検索 — 完了」、20件の取得、最終回答と6つの引用を確認した。引用の動画・開始終了時刻は元字幕と一致し、出典はすべて対象講座内だった。引用を押すと該当動画の26:11へ移動し再生できた。切り替え後にも全2,190件の読み戻し、公開head、未処理タスク0件、旧1536次元データの不変を再確認した。評価専用Lambdaは無効・予約同時実行数0に戻し、検証用のローカルサーバーとブラウザーは終了した。

初回のブラウザー質問は、会話の整理後、シーン検索の実行を観測する前にチャットエラーで終了した。原因は未特定。ツール名を明示した再実行は検索・回答・引用再生まで成功した。この確認は埋め込み切り替え経路の動作確認であり、チャット全体のエラー率や回答品質の保証ではない。

## 旧インデックスの廃止

2026-11-22、ユーザーの削除依頼により `videoq-prod-scenes-1536` を削除した。本番APIから `SCENE_VECTORIZE_1536` と、D1では不要な旧 `PGVECTOR_COLLECTION_NAME` を除去した。D1の1536次元専用シーン2,190件、配信head80件、run80件、タスク2,344件を削除した。削除前に全旧シーンの本文・動画・時刻・種別が現行768次元にも存在することを照合し、削除後にも現行2,191件が変更されていないことを確認した。元字幕・動画・共有source revisionは削除していない。

通常CDは、旧接続が本番・設定の両方から既に除去され、同じ本番D1とWorkers AIの768次元接続が維持されている状態だけを受け入れる。片側だけの接続追加・削除、モデル設定の不一致、稼働中インデックスの消失は拒否する。開発・オンプレミス向けOpenAI互換実装と過去の移行・比較記録は維持する。

## TypeScript ワーカーへの移行準備

検索・アカウント処理を TypeScript に共通化する実装を追加した。クラウド版の
配送先は現段階では `sqs` のままとし、コード追加だけでは切り替えない。
`ACCOUNT_JOB_BACKEND=cloudflare` は `ACCOUNT_JOBS`、
`SEARCH_JOB_BACKEND=cloudflare` は `SEARCH_JOBS` と `SEARCH_INDEX_WORKFLOW` を使う。
動画処理からの検索ジョブは、メディア Lambda 側の `SEARCH_JOB_BACKEND` もそろえ、
署名付き内部 API の outbox を経由して渡す。

本番向けの追加 binding は `infra/cloudflare-background.production.json` に準備してある。
最初の配備では本番 API の binding を増やさず、既存の SQS 配送を維持する。
`Sync Cloudflare Resources` の `prepare_background_queues=true` を指定し、既存の
`production-infra` 承認ゲートを通して4つの Cloudflare キュー（検索・アカウントと各 DLQ）を
作成する。その後、準備済みの binding を本番 Wrangler 設定へ反映した変更をレビューし、
Workflows を含む API を配送先 `sqs` で配備する。隔離したデータで登録・再試行・
途中再開・権限境界を検証する。

配送先の切り替え前に、DB メンテナンスの停止・復元処理を新しい実行環境へ対応させる。
現在の停止処理と smoke イメージ確認には旧3 Lambda の固定参照が残っている。
`background-queue-admission.cjs` は本番の検索・アカウントキューだけを対象に、
元の停止状態を保存する計画、設定・consumer の同一性確認、配送停止と元の状態への復元を提供する。
メンテナンス所有権と復元可能な状態の検証は呼び出し元に必須とし、通常の CI でテストする。
`background-workflow-admission.cjs` は検索 Workflow の実行一覧を cursor で走査し、
元の停止状態と実行バージョンを保存して停止・復元する。`waitingForPause` は未完了とし、
追加された実行やバージョンの変化は停止確認を拒否する。通信応答を失った場合も同じ実行を
読み直し、停止済みの実行へ要求を重複送信しない。もともと停止していた実行は再開しない。
`background-maintenance.cjs` は元の計画・停止確認時刻・復元開始を create-only の
永続ストアに保存し、キュー停止→16分の排出待ち→Workflow 停止→復元を調停する。
各呼び出しは待機せず状態を返す。再実行時は保存済みの計画を使い、復元開始後の再停止は拒否する。
停止・復元部品は `canonical-background-maintenance.cjs` を経由し、既存の移行実行の
全体ロックと DynamoDB の実行記録へ接続した。計画の create-only 書き込み時に、
同一実行・ソース SHA・停止確認付きの全体ロックをトランザクションで検証する。
`enable_background_maintenance=true` のオプトイン時だけ移行ジョブが専用資格情報を読み、
停止→スキーマ移行→成功記録→元の停止状態への復元を行う。API の全体停止は解除しない。
失敗時は停止を維持し、同一実行の再試行では保存済みの計画から復旧する。
本番でのオプトインと実際の AWS/Cloudflare 権限・復旧検証はまだ行っていない。
スキーマ移行の実行前後の読み取りガードは `aws-canonical-migration.cjs` へ接続済みで、
キューと Workflow の停止が確認できなければスキーマ変更を拒否する。
キュー停止だけでは配送済み handler や起動済み Workflows の停止を証明できないため、
実行中 Workflows の停止確認・再開、処理中 handler の排出確認、保存済み計画からの復旧、
撤去後の Lambda 構成確認を含む統合検証が済むまで配送先を切り替えない。
Queue の配送制御は [Cloudflare Queue PATCH API](https://developers.cloudflare.com/api/resources/queues/methods/edit/)、
Workflow の停止・再開は [公式の実行制御](https://developers.cloudflare.com/workflows/build/trigger-workflows/) を参照する。

運用制御の統合検証後、進行中の CD がないことを確認し、
`CLOUDFLARE_BACKGROUND_JOBS_ROUTING_ENABLED=true` を設定して承認付き Terraform
Apply で `cloudflare_background_jobs_routing_enabled=true` を反映する。この段階は
メディア Lambda の検索ジョブを署名付き API へ渡す変更だけで、旧検索・アカウント
Lambda とキューは維持する。API 側がまだ `sqs` なら同じ outbox から旧 SQS へ配送する。

次に API の `SEARCH_JOB_BACKEND` と `ACCOUNT_JOB_BACKEND` を `cloudflare` へ
切り替え、実際の登録・検索・削除を確認する。メディア Lambda の配送先更新から
更新前の実行が終わる最大タイムアウト（本番では900秒）以上が経過してから、旧 SQS の
可視・処理中・遅延メッセージと各 DLQ が継続して0件であることを確認する。
元のメディア用キューと DLQ にも旧混在メッセージが残っていないことを確認する。
更新前の処理が残る間は旧 consumer を撤去しない。これにより内部 API と保守処理を
止めずに排出でき、DB 移行用の全トラフィック停止フラグを排出手段として使わない。

切り替え後の確認が完了したら Terraform の
`cloudflare_background_jobs_enabled=true` で検索・アカウント Lambda とその
イベントソースを撤去する。残るメディア Lambda は `media` 専用になる。
リポジトリ変数 `CLOUDFLARE_BACKGROUND_JOBS_ENABLED=true` は Terraform と CD の
両方へ適用され、以後のイメージ更新が撤去済みの関数を対象にしないようにする。
進行中の CD がないことを確認してから設定し、承認付き Terraform Apply を実行する。
旧キューと DLQ の撤去は、空であることを再確認した後の別段階で
`RETIRE_BACKGROUND_QUEUES=true`（Terraform の `retire_background_queues=true`）を使う。履歴ログとメディア用リソースは保持する。

[実装時の検証記録](../validation/typescript-background-migration-2026-11-22.json)
には、本番切り替え前の結果と未完了項目を分けて記録する。
