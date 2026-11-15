# 復旧後の認証・ジョブ継続の隔離検証

2026-11-15。実PostgreSQL → ローカルworkerd D1 → PostgreSQLの往復で、認証とジョブ状態の継続を追加確認した。[全量復旧検証](d1-visual-full-backup-recovery.md)に対する補完であり、本番切替・マージ・本番ログインは実施していない。

## 確認した動作

`d1-auth-queue-recovery.integration.test.ts` は実Drizzleスキーマから専用PostgreSQLスキーマを生成し、実Better Authで合成ユーザーへ署名付きCookieを発行する。共通56テーブルを既存の型変換契約でD1へコピーし、同じsecretとURLを使ったD1認証でそのCookieが通ることを確認する。別secretの署名では拒否される。発行時のSecure・HttpOnly・SameSite=Lax属性も検査する。Cookie cacheとsession refreshを無効化したセッション読取でDB状態を確認する。

続いてD1側の実Google認証開始・callback handler、実IDトークン検証、実DBアダプターを通す。外部のGoogle token/JWKS応答だけを合成する。認可コードとPKCE verifierの交換、メール所有関係のリンク、セッション発行、access/refresh tokenが平文で保存されないことを確認した。memory認証DBには差し替えていない。

そのD1スナップショットを実復旧処理でPostgreSQLへ戻し、以下を検証した。

- PGで発行した移行前CookieとD1で発行したCookieが、復旧したPGで同じ所有者に結び付く。
- 暗号化されたGoogle access tokenを復号でき、refresh tokenによる更新要求にも保存済みの平文値を正しく渡せる。更新後の両tokenも暗号化される。
- Google側セッションのログアウトはDB上でも失効し、独立した移行前セッションは維持される。
- D1で完了したジョブはPGで再claimしてもcompletedとなる。failedジョブは新しいリースで再試行でき、古いtokenでは完了できない。再試行完了後の重複claimもcompletedになる。
- D1で完了したOutbox配送は復旧先でclaimされない。

PGへの切り戻し設定も、cloud + postgres +明示的な`MIGRATION_ALLOW_CLOUD_POSTGRES=true`という既存の設定契約に合わせた。onprem設定でGoogleが無効になる初期フィクスチャと、フォーム本文の型を誤って文字列に限定した初期試行は失敗し、テスト設定を直した。アプリ側の認証・ジョブ実装をテストに合わせて変更していない。

## 実行結果と範囲

追加の往復試験に加え、両DBのJobRepository/Outbox契約、D1認証、採番復旧を合わせた7ファイル35件が成功した。API型チェックと追加テストのlintも成功した。接続先はloopbackだけの専用Docker PostgreSQL/pgvectorで、試験後にコンテナ・匿名ボリューム・一時接続情報を削除した。Cloudflare/AWS恒久リソース、SQS配送、Lambda起動、メール送信は行っていない。[集計証跡](evidence/d1-auth-queue-recovery-2026-11-15.json)。

```sh
cd apps/api
# ローカル専用PG/pgvector接続をPERSISTENCE_TEST_DATABASE_URLへ設定
npx --no-install vitest run test/persistence/d1-auth-queue-recovery.integration.test.ts
```

この試験は停止した状態のDBを扱う。処理中リースと未処理Outboxは既存復旧処理が拒否するため、本番キューのdrain・再配送・writer fenceを検証したものではない。会話エージェントの実行再開も対象外である。

ブラウザーでは本番`https://videoq.jp/login`にGoogleボタンが表示されることを確認したが、ログイン済みセッションはなかった。Googleへのログイン操作はせず、作業スペースを終了した。これは本番Cookieの継承やブラウザーによるSecure Cookie受理を証明する検査ではない。隔離先で利用できるGoogle client・許可済みredirect URI・実行資格情報は確認できていないため、実Google連携は未検証のままとする。秘密値の提示をユーザーへ求めない。

## 本番受け入れ判断

現時点では切替保留を維持する。今回閉じた範囲は、合成provider応答を使う実DBの認証往復、暗号化tokenの更新、停止済みジョブ状態の再開である。残る条件は次のとおり。

| 条件 | 現状と次に必要な証拠 |
|---|---|
| 外部認証と実Cookie | 隔離用Google連携設定での実ログインと、ブラウザーでのCookie継続・失効の確認 |
| キューと外部副作用 | 実SQS/Lambdaをfence/drainして復旧し、再配送・Stripe等を含めて二重実行しない確認 |
| RTO/RPO | 書込停止から照合・再開までの計測。テスト全体の実行時間をRTOとして採用しない |
| 性能 | [同一Workerの検索計測](evidence/d1-singapore-scene-performance-2026-11-15.json)では通常検索p95がPG 28 ms、D1/Vectorize 281 ms。配置条件に限界があり、主要API全体の改善を示さない。改善条件の確認と同時負荷・cold測定が必要 |
| 検索品質 | [固定質問の相対回帰](d1-automatic-query-evaluation.md)は合格。絶対品質や映像依存質問の正当性へ拡張解釈しない |
| 費用 | [容量・料金試算](evidence/d1-v3-capacity-cost-assessment-2026-11-14.json)は既存条件の例。実トラフィック・全サービス費用・月額上限の受け入れは未完了 |

性能・予算の停止条件を認証テストの成功で解除しない。旧27テーブルの保管方針、完全バックアップ、本番Neonの正本は維持する。
