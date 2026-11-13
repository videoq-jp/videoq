# D1 / Vectorize 移行検証環境

2026-11-13に、既存の本番Worker・Hyperdrive・R2とは独立した検証リソースを作成した。

| 種類 | リソース | 設定 |
|---|---|---|
| D1 | videoq-d1-migration-staging | 538bebc4-9485-4e91-8799-c236eeed1dd2、APAC（実行時NRT） |
| Vectorize | videoq-scenes-migration-1536 | 1536次元、cosine |
| Vectorize | videoq-scenes-migration-768 | 768次元、cosine |

両Vectorizeにuser_id（string）とvideo_id（number）のmetadata indexを作成・一覧照合した。D1にはdrizzle-d1の0000〜0017を適用した。
構成は`apps/api/wrangler.d1-staging.jsonc`に保存する。本番のwrangler.jsoncは変更していない。
専用configはworkers.dev・preview URL・routesを無効にし、binding確認用のmainも404だけを返す。アプリの公開routeやproduction secretを持たない。

## 合成データのremote smoke

```sh
npm run db:d1:staging:smoke --workspace @videoq/api
```

Wranglerのremote binding proxyを使い、D1のuser/video/scene作成、LangChain経由の既存Embedding配信、Vectorize getByIds、所有者/動画filter付き検索、D1本文hydrateを検証する。768/1536それぞれ2人分の合成sceneだけを使う。元の動画や本番データ、Embedding/LLM APIを使わない。
専用configのDB ID・index名・非公開route設定を起動前に固定照合し、別targetには実行しない。

合成user IDはmigration-smoke-接頭辞を持つ。この専用DBで残った同接頭辞のテスト行だけを、開始時と終了時に片付ける。vector削除要求とDBの依存順削除を行い、元IDのgetByIdsで削除反映を確認する。検証中の経過は件数のみ出す。

合格しても、実データ移行・認証/全体E2E・Recall/ランキング・性能/容量/コスト・復旧の受け入れ基準を満たしたことにはならない。
リソースは引き続き移行リハーサル専用として保持する。本番切り替えは実施していない。

## 2026-11-13の実測結果

実D1/Vectorizeで合成probeが成功した。4ベクトルをID指定で取得し、両次元のfilter検索からD1の正本文を取得した。別所有者による2件の参照は空結果だった。取得値の次元とfloat32精度もprobeで確認した。
初期化から確認までは97,575msで、検索/API単体のレイテンシ値ではない。新規indexへの非同期反映では0→1→2→3→4件の段階的な可視化を観測した。書込受付だけで移行完了にせず、全件のID取得とscope検索を待つ必要がある。
検証後、合成vectorの削除反映を確認した。cleanupはremote削除が見えるまでD1の対象IDを残すようにし、途中失敗時も次の実行で再試行できる。残存合成データだけの修復は次のコマンドを使う。

```sh
npm run db:d1:staging:smoke --workspace @videoq/api -- --cleanup-only
```

[検証記録](evidence/d1-staging-smoke-2026-11-13.json)はこの合成probeの範囲だけを示す。実データのRecall/ランキング、負荷時p95、認証/動画処理E2E、本番移行・復旧の合格証拠ではない。


## アーカイブ投入・配信・照合

`db:d1:staging:migrate`でprivate archiveを指定してimport/deliver/verifyを分けて実行できる。target validatorはsmokeと共通で、任意production targetは受け付けない。接続前にarchiveを固定・検証し、phase完了後にproxyとprivate spoolを解放する。
詳細は[移行前検証手順](d1-migration-preflight.md#専用リモートstagingの段階別コマンド)を参照する。visualが未移行の場合は既定で拒否する。


## PostgreSQLアーカイブのremote移行リハーサル（2026-11-13）

ローカルの使い捨てPostgreSQL 17/pgvectorで、リハーサル実行時の57テーブルのschemaと合成11行を作り、private archiveへexportした。認証credential/session、動画、course/question/reply、768/1536 Embeddingを含む。fixture生成はPERSISTENCE_TEST_DATABASE_URLのloopback接続と、新規ランダムschemaだけを使い、終了時にそのschemaを削除する。

```sh
PERSISTENCE_TEST_DATABASE_URL='<local disposable PostgreSQL URL>' \
  npm run db:d1:rehearsal:fixture --workspace @videoq/api -- \
  --output /absolute/private/path/synthetic.videoq-export.ndjson
```

実Cloudflareでimportを2回実行し、55共通テーブルの値/FK照合と13採番状態の復元、両次元の2シーン投入、同一archiveの再実行に成功した。deliverで2件を配信後、verifyで全件の元Embedding/metadataを照合し、missing/mismatched/pendingはすべて0だった。

Better Authのremote opt-in試験も成功し、PostgreSQLで生成したcredentialによるsigninと、発行sessionのD1 DB読込を確認した。元の合成session行は保持し、テストが発行したsessionだけを終了時に削除する。

```sh
PERSISTENCE_REMOTE_REHEARSAL_TEST=1 npm run test:unit --workspace @videoq/api -- \
  test/persistence/d1-auth.remote.integration.test.ts --maxWorkers=1
```

この試験は通常CIではskipし、上記の合成archiveを専用targetへ入れた後だけ実行する。[リハーサル記録](evidence/d1-archive-rehearsal-2026-11-13.json)はこの範囲に限る。元browser cookieの互換性、本番ユーザー、visual/checkpointのremote移行、検索品質・性能、復旧の証拠ではない。

現在の専用D1とVectorizeには、この合成リハーサルデータとimport receiptを後続検証用に保持している。private archiveも再試行/照合用として一時privateディレクトリに保持する。通常smokeのcleanupはmigration-smoke-接頭辞だけを対象にするため、rehearsalのデータは消さない。別archiveを投入する前に、対象データ・receipt・vectorを検査し、意図したresetか別の専用targetを用意する。


## Time Travel復旧演習（2026-11-13）

専用D1の合成データで復旧演習が成功した。68テーブルのtable DDL/column metadata・行値・sqlite_sequence・D1 migration履歴を、値を出さないhash/countとしてprivate fileへ記録した（52行、migration履歴等も含む）。
Time Travel bookmarkを取得した後、合成videoのtitleだけを変更し、差分検証が拒否することを確認した。保存bookmarkへ実際にrestoreし、元の比較hashと完全一致した。再接続後のVectorize照合は2/2件一致、認証のremote試験も再度成功した。

```sh
npm run db:d1:staging:recovery --workspace @videoq/api -- \
  --mode prepare --state /absolute/private/path/recovery-state.json
# この時点で専用configのTime Travel bookmarkをprivateに保存する
# npx wrangler d1 time-travel info DB --config wrangler.d1-staging.jsonc --json
npm run db:d1:staging:recovery --workspace @videoq/api -- \
  --mode mutate --state /absolute/private/path/recovery-state.json
# apps/apiをcwdにし、専用configと保存bookmarkを再照合して実行する
D1_RECOVERY_BOOKMARK='<saved private bookmark>'
npx wrangler d1 time-travel restore DB --config wrangler.d1-staging.jsonc \
  --bookmark "$D1_RECOVERY_BOOKMARK" --json
npm run db:d1:staging:recovery --workspace @videoq/api -- \
  --mode verify --state /absolute/private/path/recovery-state.json
```

Wranglerのコマンドはapps/apiをcwdにする。restoreは[CloudflareのTime Travel仕様](https://developers.cloudflare.com/d1/reference/time-travel/)どおりDBを上書きし、実行中のSQLを取り消すため、route・scheduler・外部writerを停止/drainし、proxyを閉じてから実行する。今回の専用configには公開routeやschedulerがない。戻す前後のbookmarkはprivateに保存し、元へ戻す手段も保持する。--jsonは対話確認なしに実行するため、対象は既知の専用staging configに固定して照合する。

状態検証toolは既知の専用targetと合成2ユーザーだけを許可し、他データや大きなtableを拒否する。private stateは復旧用DBバックアップではなく比較記録である。テーブル外のindex/trigger DDLはhash対象外で、汎用の本番バックアップ検証toolとしては使わない。

D1の復旧はVectorize・R2・SQS等を同時には戻さない。今回はそれらを変更せず、復旧後に元archiveとの照合を行った。外部writerやjobが動いている状態、実ユーザーデータ、Neonへの逆移行、RTO/本番切り戻しを検証した証拠ではない。[結果記録](evidence/d1-recovery-rehearsal-2026-11-13.json)を参照する。


## 最新main統合後の差分

教員接続を含む現在のコードは、PostgreSQL 58テーブル・共通行移行56テーブル・D1 migration 0018までを使用する。この文書のリモート成功記録は0017までのschemaに対するもので、0018のリモート適用と新archiveでのリハーサルは未実施である。以前のimport receiptや復旧fingerprintを、新schemaの検証結果として流用しない。本番設定・本番データは変更していない。
