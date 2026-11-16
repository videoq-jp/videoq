# 本番切り替えの残件と最新候補

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
