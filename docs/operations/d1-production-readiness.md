# D1運用の受入条件と移行時の履歴

## 現在の判断入口（2026-11-24）

この節を現在の判断入口とし、後半の2026-11-16の記録は移行前の履歴として読む。
「Neonを継続」「本番切り替え未実施」という過去の記述を、現在の配備指示として使わない。
現行リポジトリの本番設定はD1・768次元Vectorize・Workers AIを選択する。
オンプレミスはPostgreSQL/pgvectorを維持する。

今回確認した比較元mainは `007b4f9668e75405cb85808c6633f78dae444444`。
このSHAの[通常CD](https://github.com/videoq-jp/videoq/actions/runs/45395076526)は
2026-11-24 12:36 UTC開始・successである。これはGitHubの配備処理の証跡であり、
現在の実リソースの設定や全機能を今回再試験した証明ではない。
[PR #1672](https://github.com/videoq-jp/videoq/pull/1672)は別の変更候補で、
その最終headのCI・受入結果を比較元の成功で代用しない。

### 構成と証拠の対応表

| 判断対象 | 証拠の日時・条件 | 現在言えること / 適用限界 |
|---|---|---|
| 正本と検索基盤 | 上記mainの[本番設定](https://github.com/videoq-jp/videoq/blob/007b4f9668e75405cb85808c6633f78dae444444/apps/api/wrangler.jsonc) | `videoq-prod-db`、`videoq-prod-scenes-embeddinggemma2-768`、`embeddinggemma2` / `@cf/google/embeddinggemma-2`を選択。検索・accountはCloudflare、媒体はPython。配置・実bindingの今回のライブ照合は未実施 |
| 入力データと検索品質 | [11/22の固定比較](workers-ai-embedding-migration.md)、[集計JSON](../validation/workers-ai-embedding-comparison-2026-11-22.json) | 16動画・420scene、24正例質問・4診断・56owner負例、3反復。事前のHit@5/Hit@20/MRR差と越境0の基準を通過。AI由来の非網羅ラベルで、人手正解や回答全体の保証ではない |
| 全件展開と索引の世代 | [11/22の展開・旧索引廃止](workers-ai-embedding-migration.md#旧インデックスの廃止) | 展開時80動画・2,190sceneを照合。旧1536次元索引は削除済み、削除後の現行2,191件の不変を確認した記録。これは11/24の現在件数ではない。旧索引へのbinding切戻しは利用不可 |
| 検索呼出し単体の性能 | 同じ11/22比較、逐次・同一ローカルclient、各質問3反復 | Vectorize API p95は旧238.5ms / 候補236.6ms。Embedding・認可・D1 hydration・回答生成を含まない。cold/同時負荷のE2E改善やSLO合格には使わない |
| 認証付き参照APIの性能 | [11/16の比較](d1-authenticated-api-performance.md)、NRT、warm・逐次、各scenario 20標本 | Hono全scenario p95はPG519ms / D143ms。別のモデル・配置・候補SHAへの一般化や、RAGのp95への置換は不可 |
| 現行ASRと回答 | [11/24のASR検証](workers-ai-transcription.md)、[11/22の回答移行](workers-ai-answers.md) | 現行推論の経路と限定された受入証跡。旧OpenRouter/OpenAI専用評価Lambdaは[廃止済み](../../infra/search-evaluation/README.md)。旧runtimeを復旧用に再作成しない |
| 再試行と原子性 | PR #1672の共通wire契約、実PG/SQS互換障害試験、ローカルD1契約 | job identity、ACK失敗、SIGTERM、quota/返金境界を限定した環境で検証。最終head・本番配置での全E2E、実外部課金やメールの巻戻しを証明しない |
| 費用と容量 | [11/16の利用量](d1-account-capacity.md)と11/22の構成変更 | 計測期間・旧モデル・廃止資源が異なるため現在の月額総費用へ外挿しない。現在契約、通常/ピーク、復旧再生成、承認済み予算の照合は未測定で、費用削減を合格にしない |
| 復旧可能な範囲 | [過去の隔離演習](d1-lambda-time-travel-recovery.md)、[旧世代の再構築記録](d1-vectorize-recovery.md) | DBと外部状態は単一transactionでは戻らない。旧1536次元の実証・廃止済み評価runtimeを、現行768次元の再構築成功と扱わない。最新構成の統合復旧と本番RTOは未実証 |

### 次の候補を測る前に固定する受入条件

候補を変更するたびに全履歴を再実行する必要はない。次の表を一つの受入記録として
候補SHAと設定digestに結び、変更で影響する行を再検証する。モデル、入力形式、次元、
検索スコープ、DB schema、認可、queue topologyが変わった行の古い成功は継承しない。

| 項目 | 測定前に固定する入力 | 採用条件 / 拒否・中止条件 |
|---|---|---|
| 同一性 | 候補SHA、Worker revision、image digest、モデル/profile/prefix/次元、配置、schema、データsnapshot hash、日時 | 検索側・登録側が同じ契約。途中で変わった測定は混ぜず再試験 |
| 正しさと認可 | 凍結した質問・根拠scene、owner/course負例、更新/削除競合 | 越境0、旧revision非公開。違反時は性能に関係なく公開を止め、同じ操作を無条件にACKしない |
| RAG | 初回回答までと回答完了までを分離し、cold/warm・逐次/同時負荷別に標本数・p50/p95/p99・失敗率を固定 | 同条件の比較元を超えるp95/失敗率の悪化を承認なしに採用しない。品質の基準も維持。検索API単体値で代用しない |
| 参照API | 認証込みのroute別計測、tenant規模、浅い/深いpage、cold/warm・並行度 | RAGと独立してp95/失敗率を比較し、同条件の比較元より悪化したrouteは原因を解消してから再判定 |
| 費用 | 現行契約、保持量、通常/ピークのリクエスト、再試行・索引更新・復旧再生成、承認済み月額上限 | 上限が未設定、または総費用を算出できない場合は費用面を未合格とする。測定後に予算を緩めて合格にしない |
| 復旧 | 対象DBとbookmark、R2 object世代、索引/モデル、queue/workflow/outbox、停止/drainと照合手順 | 隔離先で対応する世代を復旧し、削除・重複・欠損・権限を照合して再開。対象外を明記。未完了ならその変更の本番復旧可能性を合格にしない |

上記の性能条件は次回比較の回帰ゲートであり、契約上の応答時間SLOではない。
RAGと参照APIの数値SLO、期間/対象利用者、error budget、RPO/RTO、月額上限は
プロダクト/運用責任者が測定前に記録する。今回その合意や数値を作っていない。
未設定を「無制限」や「既存実測で達成」と読み替えない。

### 切り戻しの対象と撤退判断

| 対象 | 復旧時に照合するもの | 併せて戻らないもの / 現在の制限 |
|---|---|---|
| D1 | 確定した復旧時点、schema、FK、認証、課金/利用枠、job台帳、公開head | Time TravelはR2、Vectorize、外部課金/メール、queue/workflow状態を同時に巻き戻さない |
| R2 | 元動画と採用された不変キー/manifest、DBの参照、削除Outbox | DBだけ戻して既に削除されたobjectを復元した扱いにしない |
| Vectorize | 現行モデル/prefix/768次元で再生成した値、physical ID、owner/video/revision、ANN反映 | 旧1536次元索引は削除済み。過去の再生成ツール/runtimeは現行768次元の実行手段として検証されていない |
| Queue / Workflow / Outbox | 停止・drain、未配信/処理中/完了、同じjob IDと実行barrier、外部副作用 | DB復旧後に完了済み副作用を無条件再送しない。consumerの変更時は互換payloadと旧実行の排出を確認 |
| Neon / 旧provider | 過去の移行記録のみ | 廃止済み資源や旧archiveへの単純な接続変更は撤退手段ではない。再作成や本番restoreはこの文書更新では実行しない |

認可/整合性違反は受付・公開を停止して調査する。性能悪化は影響routeの候補を
採用せず、データ互換な既知のアプリ版へ戻せるかを先に確認する。D1に新しい書込みが
入った後は接続先だけを戻さず、上表のDB・object・検索・配送を含む復旧計画を実証する。
継続運用と追加移行の判断を分け、未測定の規模を理由に新しい分散構成を増やさない。

## 2026-11-16の移行前履歴

2026-11-16 JST。目的はクラウド版の本番D1/Vectorize切り替えと、オンプレミスPostgreSQL/pgvectorの維持である。以下は途中の受け入れ監査であり、完了宣言ではない。旧Django/OAuthの27テーブルは完全バックアップに保管し、現行アプリだけをD1へ移す。

## 候補の統合

PR #1434は最新main `b01b41b4`と競合していた。`e0cb0a7a`で競合を解消し、配備済みPython内部APIのUser-Agent修正、対応テスト、Python 3.14.10の固定情報、rollout文書を取り込んだ。mainのコードを削って競合を解消していない。後続PR #1448→#1449→#1450にも順に反映した。

更新前のPR #1450 head `7c9df364`はHonoを含むCI/CodeQLが成功した。更新後の候補`12be21d0`では、専用loopback PostgreSQL/pgvectorとローカルD1で、認証継続・逆移行・復旧fingerprintの3ファイル28テストが成功した。Pythonの署名、User-Agent、Lambda、SQS、シーン処理の対象83テストも成功した。ローカルPython試験は3.12であり、3.14の実行証跡には扱わない。専用コンテナ・匿名volume・資格情報ファイルは撤去済み。更新後各headのCIは別途確認する。

## 受け入れ条件別の残件

| 計画書の条件 | 現在の証拠と残件 |
|---|---|
| 1. 両環境E2E | 既存のオンプレCPU/通信遮断CIと隔離cloud動画E2Eがある。最終候補の両環境CIを固定し、cloud再実行ではジョブ失敗件数も個別に説明できることを条件にする。 |
| 2. 移行整合性 | [全量バックアップと復旧コピー](d1-visual-full-backup-recovery.md)で実証。最終書き込み停止後の一貫snapshot、採番床、差分・全値照合は本番切り替え時に実施する。 |
| 3. 認証・課金・利用枠・ジョブ | [認証復旧](d1-auth-queue-recovery.md)でCookie、暗号化token、合成Google callback/refresh等を確認。本番OAuth設定・cookie属性・暗号鍵の継承、課金経路、復旧後の外部連携を最終候補で確認する。外部Googleへの実ログインを合成試験で代用しない。 |
| 4. RAG品質 | [40質問の相対比較](d1-automatic-query-evaluation.md)と所有者負例を確認済み。回答を含む固定評価を最終候補で再確認し、非網羅AI候補を完全Recallと呼ばない。 |
| 5. 同時実行・再試行 | [実Lambda/D1復旧](d1-lambda-time-travel-recovery.md)、[実SQS/PG復旧](d1-sqs-recovery-replay.md)を別々に確認。外部副作用の再試行、部分失敗、削除後の非表示と残存オブジェクト照合、検索反映完了までの保証を詰める。 |
| 6. 性能改善 | **未達**。[同一Workerの実検索](d1-same-worker-scene-performance.md)では改善していない。認証を含む主要APIの同じデータ・配置・cold/通常/同時負荷の比較を追加し、原因に応じて実装を改善する。認可削除・検証範囲縮小で合格にしない。 |
| 7. 制限・予算 | [アカウント全体の容量・30日利用量](d1-account-capacity.md)を取得し、現在の保存量はFree/Paid双方に適合した。実契約、移行後の通常/ピーク構成、総費用と予算判定は未完。Neonの現行固定費0だけからD1の費用削減を主張しない。料金プラン変更はこの統合作業で行わない。 |
| 8. 復旧 | D1 Time Travel、実データのローカルPG逆移行、版付き画像の互換復旧を確認。現状の逆移行CLIはloopbackの隔離DB限定であり、**本番Neonへ戻す実行ツール・writer fence・実行手順は未完成**。これを完成させ、外部状態とキューを含めて切り戻しの範囲を実証する。 |
| 9. オンプレ非依存 | 既存の実CPU・通信遮断CIはある。統合後の最新headで再検証する。 |

## 次の実装・検証順

1. 最新mainを含む候補とCIを固定する。後続PRの変更を取りこぼさず、本番設定はNeonのまま維持する。
2. 性能の主要API比較を追加し、改善を実測する。性能目標を測定結果に合わせて後付けで緩めない。
3. 本番用の停止/drain・整合snapshot・逆移行・外部状態照合・再開手順とツールを作成し、隔離先で通す。ローカル限定guardを単に削る方法は採用しない。
4. 本番候補のE2E・OAuth設定継承・外部副作用の失敗/再試行・費用を確認する。
5. 受け入れ条件の根拠が揃ってから、最終バックアップ、書き込み停止、最終同期、全量照合、切り替え、監視、必要なら検証済み手順による復旧を実施する。

CI成功や一つの復旧試験だけで全条件を満たしたと判断しない。Neonの廃止は切り替え後の安定化と復旧手段の維持を確認してから行う。

## D1行書き込み停止の追加実証（2026-11-16）

[管理コマンド](d1-write-fence.md)を専用の実D1で実行し、68テーブル・204トリガーの全照合、別の管理APIからの4書き込みの拒否、全行hash保持、明示解除と更新再開、DB撤去を確認した。これはDBの行操作に対する防御の追加であり、上流writerの停止・DDL禁止・外部副作用・Neon逆移行ツールを完成とするものではない。上表の未達条件は維持する。

## Neon管理対象ログイン停止と性能試作（2026-11-16）

[Neonログイン停止コマンド](neon-login-fence.md)を追加し、専用PGで既存接続の終了・NOLOGIN・readonly backup維持・明示解除・role drift/準備済みtransactionの拒否を検証した。AWSの管理operation/global lockへの統合は残っており、本番Neonでは未実行。

[D1並行取得の試作](d1-parallel-prefetch-diagnostic.md)は通常検索p95が477msで、現行D1 305ms・PG 223msより悪化したため不採用。認可・品質を保った改善が未達であることを維持し、試作のp50だけで切り替え可とはしない。PR #1434の全CI（実CPU・外部通信遮断を含む）が成功し、Neonを継続する基盤リリースとしてmerge queueへ登録した。本番D1切り替えは未実施。

## 基盤リリース完了と参照API性能（2026-11-16）

PR #1434はmain `6882f06f`へマージされ、main CI・通常CD・DB Maintenance CDが成功した。配備後のhealth/readyは200、3 LambdaはActive/Successful。D1 bindingと切り替え変数は未設定で、本番はPostgreSQLを継続する。

[認証付きの参照API比較](d1-authenticated-api-performance.md)では、同一ownerの6 scenario・240リクエストで応答を照合し、NRTのHono p95はPG 519ms、D1 43msだった。migration後のindexing状態へPGコピーを揃え、D1のreadinessは緩めていない。これはwarm・逐次・参照APIに限定した進展であり、RAG回帰、cold/同時負荷、本番runtime/config、その他の受け入れ残件を解決したとは扱わない。

## 復旧transactionと停止ロックの結合（2026-11-16）

[Neon停止の復旧transaction](neon-login-fence.md#復旧トランザクション中の停止維持2026-11-16)を追加し、実D1行の復元を保持中のlogin fence transactionへ接続した。競合解除・二重実行・失敗rollback・role drift・採番維持を含む4ファイル14テストと既存単体21テストが成功した。隔離DB限定は維持し、本番向けAWS operation/逆移行CLIが完成したとは扱わない。

## 公開基盤版のオンプレ受け入れ完了（2026-11-16）

main `6882f06f`の[On-prem Release実行](https://github.com/videoq-jp/videoq/actions/runs/43747462122)も全jobが成功した。成果物のsource SHAを照合し、署名・chart・image indexの検証後、実CPUのASR/embedding/chatと公開日本語fixtureによるアップロード→検索→出典付き回答、streaming、動画再生、object/DB復旧、upgrade/rollback、Helm、保持処理の成功を確認した。runtimeの外向きIPv4/IPv6通信と外部DNSは遮断され、worker Podのprobeも成功している。これは専用nodeのfirewall境界であり、CNIの検証ではない。[集計証跡](evidence/onprem-foundation-release-2026-11-16.json)。cloudのOpenRouter試験や、最終D1候補の受け入れを代替する結果とはしない。

## AWS側の停止計画準備経路（2026-11-16）

[読み取り専用のAWS監査](neon-login-fence.md#aws内の読み取り専用準備経路2026-11-16)を既存broker・global lock・固定rotation job・versioned bundleへ接続した。実ZIP/PGとAWS親の資格情報分離、条件付き保存・読み戻し、応答喪失を検証し、ASLはAWS検証APIでOKとなった。本番未実行。これは準備経路であり、停止維持のdurable lease、install/release、上流停止、最終snapshot/本番逆移行、RAG性能等の受け入れ残件は維持する。


## 停止制御・監査のmain統合候補（2026-11-16）

個別PR #1458〜#1465と#1479の変更を、main `161cf139`を含む単一の候補へ統合した。元の個別PRと試験記録はレビュー用に残す。対象はD1配布bindingとDB選択の保護、SQS admission制御、所有者付きdeployment/API停止と書き込み前abort、AWS内の読み取り専用activity観測、native CodeBuild完了の確認、元のPostgreSQL role計画の不変保存である。

統合した実コードでNode 453件、実DynamoDB Local 42件、AWS親の境界4件、Python 68件、Terraform模擬plan 17件が成功した。DynamoDB試験のAWS/Cloudflare/DB子処理はmockであり、結合した本番停止・drainの実証ではない。[統合証跡](evidence/cutover-control-integration-2026-11-16.json)。main向けのCI/CodeQL、オンプレrehearsalと配布物の確認を別途行う。

各機能の既定値は無効のままで、本番の設定変更・API停止・DB停止・D1切り替えは行っていない。実行caller、writer fenceの変更意図と復旧、最終snapshot/逆移行、外部状態の照合、最終候補のE2E・検索品質・性能・契約/予算の残件は維持する。
