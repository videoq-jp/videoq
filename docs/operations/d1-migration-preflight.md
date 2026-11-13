# D1移行前の計測と設定確認

この手順は移行計画のPhase 0と設定準備を扱う。データコピー・リソース作成・デプロイ・本番切替は実行しない。

## PostgreSQLのベースライン

接続先を`DATABASE_URL`へ安全に設定したシェルから、リポジトリのルートで実行する。URLをコマンド引数や記録用ログへ貼り付けない。

```sh
npm run db:d1:baseline --workspace @videoq/api -- \
  --output /absolute/private/path/videoq-baseline.json \
  --schema public --samples 30 --statement-timeout-ms 60000
```

出力先の親ディレクトリは先に用意する。同じファイル名の上書きは拒否する。JSONはmode 0600の一時ファイルへ書き、成功時だけ同一ファイルシステム内で公開する。失敗時は部分レポートを残さない。

DB処理はREPEATABLE READ / READ ONLYの一つのtransactionで行う。次を取得する。

- テーブル別の正確な行数、物理容量とindex容量、列型
- pgvector列の宣言型と、実データの次元別件数（NULLも区別）
- bigint列の範囲とJS安全整数範囲外の件数
- 現在の768/1536次元index構成で扱えない次元と、安全整数変換の要確認箇所
- 接続後のウォーム`SELECT 1`のp50/p95/p99

トークン・パスワード・本文・Embedding・ユーザーの識別情報は取得しない。出力のテーブル/列名や集計値も内部情報として管理する。

容量はPostgreSQLの物理サイズであり、D1サイズの予測ではない。ウォームprobeはNodeからDBへの往復であり、WorkersのAPI E2EやNeonのコールドアクセス計測ではない。
全件countと集計はsource DBを走査する。適切な計測時間帯を選び、必要ならstatement timeoutを短くする。
view・function・foreign table・sequence・constraintの完全な移行manifest、D1実投入後サイズ、API性能、検索Recall、料金試算は別途必要である。

## 切り替え候補のWrangler設定

```sh
npm run db:d1:cutover-check --workspace @videoq/api -- \
  --config wrangler.jsonc --env production
```

設定不足なら終了コード1、ローカル設定の必須条件を満たせば0を返す。`configuration_valid`は本番切替可否を表すものではない。

対象のnamed environmentに以下を明示する。既存のAPI/R2/DO等の設定もその環境に維持する。

```jsonc
{
  "env": {
    "production": {
      "name": "videoq-api",
      "workers_dev": false,
      "vars": {
        "ENVIRONMENT": "production",
        "DEPLOYMENT_EDITION": "cloud",
        "PERSISTENCE_BACKEND": "d1"
        // その他の既存本番varsを維持。秘密値はvarsへ書かない。
      },
      "d1_databases": [{
        "binding": "DB",
        "database_name": "<provisioned-database-name>",
        "database_id": "<provisioned-database-id>",
        "migrations_dir": "drizzle-d1"
      }],
      "vectorize": [
        {"binding": "SCENE_VECTORIZE_1536", "index_name": "<1536-index-name>"},
        {"binding": "SCENE_VECTORIZE_768", "index_name": "<768-index-name>"}
      ]
    }
  }
}
```

これは必要箇所の例であり、既存設定を丸ごと置き換えるファイルではない。placeholderのDB IDではチェックは通らない。
環境ごとのvars/バインディングはトップレベルから自動継承されないため、対象環境そのものを確認する。[Wrangler設定](https://developers.cloudflare.com/workers/wrangler/configuration/#non-inheritable-keys)を参照。

`MIGRATION_ALLOW_CLOUD_POSTGRES=true`はD1切替候補では拒否する。Neon保持のため残したHyperdriveは警告として扱う。
`WORKER_INTERNAL_API_SECRET`と`BETTER_AUTH_SECRET`等は秘密として設定し、AWS側の内部API接続設定も別途照合する。

このチェックはリモートのschema履歴、indexの実次元・metric・metadata filter、秘密値の存在、AWS設定、データ整合性、認証互換性、検索品質、性能、予算を検証しない。
本番切替には計画書の全受け入れ基準と復旧演習の証跡が必要である。

## 現在の確認結果

2026-11-13時点のリポジトリの`env.production`にはD1/Vectorize設定と明示的なcloud editionがなく、このチェックは失敗する。既存Neon設定は維持している。
今回、本番接続情報を使用したベースライン取得やCloudflareリソース操作は行っていない。

## スキーマ移行対応表

```sh
npm run db:d1:manifest --workspace @videoq/api
npm run db:d1:manifest:check --workspace @videoq/api
```

最初のコマンドは両DBの最新journal/snapshotを読み、テーブル・列ごとの変換、targetの挿入順序、専用処理を要するデータをJSONで出力する。
`--check`相当の後者は要約だけを出し、未対応のテーブル/列/型や挿入順序の未解決依存があれば終了コード1を返す。API CIでも実行する。

現行schemaでは共通56テーブルを列単位で対応付ける。PostgreSQLのEmbedding用2テーブルはscene本文とVectorizeに分割し、
D1専用11テーブルはindex同期台帳・一時状態・checkpoint・visual参照・offline import進捗などの専用方針を持つ。
Drizzle管理外の`chat_memory`も移行対象として明示する。

`mapping_complete=true`は対応表の網羅性だけを表す。`execution_complete=false`の通り、専用方針の実装・データ投入・照合が完了した意味ではない。
実DBのschemaとsequence/constraint、schema履歴、行数も別途照合する必要がある。

行変換primitiveは、pgドライバーによる暗黙の型変換より前にSQLで各列をtextへ投影する前提である。
配列はPostgreSQL配列リテラルでなく`to_json(column)::text`として取得する。JSON/JSONBもtextとして取得し、数値lexemeを再シリアライズしない。
これにより、JSON内の9007199254740993等をJS Numberに丸めない。
SQL NULLとJSON文字列`null`は区別し、日時はoffset必須でUTC ISOへ揃える。既存JS Date契約に合わせて小数秒はミリ秒へ切り詰めるため、照合も同じ正規化規則で行う。
bigintは安全整数範囲外なら値を出さずに拒否し、黙って切り捨てない。

このコマンドはschema metadataだけを出力し、本番行データを読み書きしない。行データexportは次節のCLIで提供する。importと専用データ変換は未完了である。

## PostgreSQLからのprivate archive export

本番データを扱う経路には、保守ジョブの`export_d1_from_verified_backup`（既定false）を用意した。
復元検証済みdumpの隔離DBからD1 archiveを作り、dumpとarchiveを同じprivate handoff/保全manifestへ紐付ける。
有効化には`retain_verified_backups=true`と、canonical-mainの承認済み保守コード・独立した運用設定の反映が必要である。
詳しくは[隔離backupからのD1 export手順](../../infra/db-maintenance/README.md#isolated-restored-backup-d1-export-tool)を参照する。
これは本番の保護された接続情報をローカルへ取得する許可ではない。以下の直接CLIは、承認済みのローカル/on-prem rehearsal copy等の環境で扱う。
未マッピングの旧テーブルを省略する例外や、本番切り替えの自動許可は追加していない。

移行前の保全コピーは、復元テストの成功だけでは存在しない。AWS保守ジョブには
復元検証済みdumpを専用private S3へ保存するopt-in実装を追加したが、既定では無効である。
有効化の順序・権限・保存期間・復旧確認は[保守ジョブの手順](../../infra/db-maintenance/README.md#verified-backup-preservation-for-d1-migration)に従う。
本番の保存・取得・再復元が成功するまで、未マッピングの旧テーブルを保全済みとは扱わない。
このdumpはD1用archiveと別の成果物であり、旧データの移行/保管方針を決めずにexportの網羅性検査を緩めない。

```sh
npm run db:d1:export --workspace @videoq/api -- \
  --output /absolute/private/path/source.videoq-export.ndjson \
  --schema public --fetch-rows 10
```

`DATABASE_URL`を設定したシェルから実行する。出力先の親ディレクトリは先に作成する。
このアーカイブにはsession token・認証情報・本文等が含まれる。暗号化された配布形式ではないため、DB backupと同様にprivateな保管先で扱う。
mode 0600で保存し、既存ファイルへの上書きは拒否する。許可されたsuffixと一時ディレクトリ名はリポジトリの.gitignoreにも登録している。
ログには件数だけを出し、DB接続URL・行データ・秘密値は出さない。

全テーブルを一つのREPEATABLE READ / READ ONLY transactionとserver cursorで読み、一定行数ずつ書く。
実DBの表・共通列の型を対応表と比較し、未知の表/列、型変更、不正な型変換、安全整数範囲外等は公開前に拒否する。
共通表は変換済み値、専用変換対象のEmbedding表・chat_memoryは元のtext値を保存する。byteaはhexとして保持する。
DateStyle/TimeZone/float出力精度はtransaction内だけ正規化し、呼び出し元の設定へ残さない。

各表には列名/encoding・主キー・件数・SHA-256を記録し、末尾にファイル全体のSHA-256と完了frameを付ける。
これは破損検出用のhashであり、出所の認証や暗号化を提供しない。
一時ファイルは最後まで書き、DB COMMITとfile syncを終えてから同一filesystemのhard linkで公開する。
失敗した未公開ファイルは片付ける。成功後の一時file削除等でエラーになった場合もあるため、再試行前に出力先の有無を確認する。

sequenceのhigh-water markとDrizzle履歴（存在する場合）も記録する。sequenceはMVCC snapshotの対象ではなく、最終移行時はAPI/非同期Workerの書き込み停止とdrainが必要である。
`chat_memory`の一部だけが存在する場合や、committed checkpointを持つ会話があるのにcheckpoint schemaがない場合は拒否する。

このarchiveはrestorableなPostgreSQL backupではなく、D1 importの入力形式を準備するもの。
exportだけでは移行は完了しない。後続エンジンによる共通行・sequence・checkpointの復元と照合に加え、Embedding/visual変換、リモート投入、復旧演習が必要である。
`execution_complete=false`はexport成功後も維持する。本番切替の証拠としては扱わない。

## import前のアーカイブ検証

```sh
npm run db:d1:verify-archive --workspace @videoq/api -- \
  --input /absolute/private/path/source.videoq-export.ndjson
```

現在のexportは形式version 3で、source schema名とsequenceの所有先/設定をheaderに含める。旧version 1/2は検証対象外のため、新しいファイル名で再exportする。旧archiveの途中取込先へ新archiveを混ぜず、新しいステージングDBを使う。
検証コマンドはDBへ接続せず、ファイル全体をストリームで読み取る。成功時だけ`verified=true`と表数/行数を返す。

- source/auxiliary tableの網羅性、重複、table/frameの順序と完了footer
- 最新manifestのhash、共通列の名前/型/encoding、NULL・安全整数・Boolean・日時等の変換済み値
- raw-specialのtext/bytea hex形式
- 表別の行数/hash、全体hash、footerの件数明細
- UTF-8/正規のJSON frame、途中切れ、末尾の余分なデータ

を検査する。公開読み取り権限のあるfileやsymlinkは拒否する。エラーは固定の理由だけを返し、値やJSON断片をログへ出さない。
1行の上限は既定16MiB。必要なら`--max-line-bytes`を明示する（最大128MiB）。これはローカル検証のmemory制限であり、D1にそのサイズの行を保存できることを意味しない。

SHA-256は破損検出用であり、改変者が再計算できるhashは出所を証明しない。検証後にファイルが変更される可能性もあるため、将来のimport処理は実際に投入する入力を再検証する必要がある。
`verified=true`でも、後続のimportと専用データ再構築、targetの値比較、認証/E2E/remote/復旧の検証は別途必要であり、`execution_complete=false`を維持する。

## 共通テーブルのoffline importエンジン

`scripts/migrations/d1/import-common.ts`の`importCommonTables`は、D1 bindingを受け取り共通56テーブルを投入する。
Node側の移行エンジンである。専用stagingリソースに固定したCLIは後述する。任意のリモートDB/productionを選ぶCLIや公開HTTP endpointは提供していない。
公開サービスから切り離した空のステージングDBに、最新のD1 migration（0018まで）を適用してから使う。
`offlineStaging: true`は運用側の前提表明であり、Workerのrouteを自動停止する機能ではない。本番bindingを渡さない。

エンジンはprivateな作業コピーを作り、そのコピー全体を検証した後、共通rowと専用変換用のraw rowを表ごとのprivate spoolへ分ける。
以後元ファイルが変わっても投入内容を変えない。全表をmemoryへ読み込まず、FK順に一定行数ずつbatchで投入する。
最初の書込前にtargetの表/共通列の型とNULL定義を照合する。新規importは全application tableが空であることをbatch内で確認する。

`migration_imports`にarchive/mapping hash、table/row checkpointと投入件数を保存する。各batchは行のINSERT、値一致のassertion、checkpoint更新を原子的に行う。
同じ入力の応答喪失・途中失敗は再実行で再開し、別archiveへの変更を拒否する。並行した処理はcheckpointで競合を検出する。
完了済みの再実行でも、markerを信頼するだけでなく全共通rowの値・各表の件数・`foreign_key_check`を再照合する。

返却する`common_import_complete=true`とDBの`status=common_imported`は、共通row段階の完了だけを意味する。
`execution_complete=false`と専用データの未処理件数を明示する。標準sequenceを復元・確認した場合は`pending_sequence_restore=false`を返す。
共通段階の後に次節のcheckpoint復元を実行する。Embedding/Vectorize、visual参照等の専用再構築と全体検証が終わるまでは、サービスを起動/接続しない。採番復元の規則と制約は次節を参照する。

ローカルの認証リハーサルでは、PostgreSQL Better Authで発行したCookie sessionをexport/importし、同じsecret/URL設定のD1側でcookie cacheを無効化したDB照会とパスワードログインを確認している。
これはすべての本番session/OAuth/API key/LTI鍵やブラウザ経路の互換性を証明するものではなく、移行リハーサルの一つの証跡である。


## 標準sequenceの復元

version 3のexportは、pg_dependから所有先のschema/表/列を取得し、last_value・is_called・増分・上下限・cache・cycle設定を保存する。
名前が`<table>_id_seq`であるという仮定は使わない。元snapshotと同じく、sequence状態の観測にはwriter停止/drainが必要である。

現行アプリの標準bigint sequence（増分1、最小1、最大9223372036854775807、非cycle）を対象とする。
独自の増分/範囲/cycle、未対応の所有先、複数sequenceが同じ対象を所有する場合、安全な次のJS整数がない場合は、targetの行を書き込む前に拒否する。

共通行の照合後、D1 `sqlite_sequence`を更新する。targetはINTEGER PRIMARY KEY AUTOINCREMENTでなければならない。
`is_called=true`ならlast_value、falseならlast_value-1を下限とし、既存のD1 counterと取り込み済み最大IDの最大値を保つ。
値を下げず、採番を進めるための仮の業務rowも作らない。未使用/キャッシュ割当による欠番は許容する。
D1のbind値が内部表でREALになることを避け、counterをSQL内でINTEGERへ明示変換する。

counterごとのguard・更新・存在確認・値検査は同じbatchに含める。応答を失って再実行してもcounterは下がらない。
完了markerの前に処理し、失敗したtargetはofflineのまま同じarchiveから再開する。

ローカルworkerd D1では、削除済み高位ID、restartのis_called=false、cache割当、D1側が既に大きいcounter、応答喪失を検証している。
リモートD1でのSQL権限・動作・復旧を含む本番相当のリハーサルは未実施であり、切り替え前の検証対象に残る。


## LangGraph checkpointの復元

共通importエンジンは、PostgreSQLのcheckpoint・channel blob・pending write・migration履歴をD1の会話checkpointへ変換する。Node.js 24以降と組み込みの`node:sqlite`を使用し、private作業ディレクトリ内のSQLiteで参照を解決する。全履歴をメモリに保持しない。

最初のtarget書込前に既知のsource列・migration履歴（連続した0〜5の範囲）・serializer（json/bytes）・会話所有関係・committed checkpointの存在を検査する。各checkpointのchannel versionからblobを復元し、公式JsonPlusSerializerで全体を再保存する。数値versionはPostgreSQL JSONBの字句表現を使い、`1.0`等のblob参照を維持する。bytesはUint8Arrayへ正規化する。

namespace、parent、metadata、pending writeのtask/index/pathを保持する。欠損blob、不明形式、不正write、D1の1,800,000 byte予算を超える行は拒否する。参照されない旧blobはtargetへ複製せず、`checkpoint_migration.unused_blobs`で件数を報告する。元のprivate archiveには保持される。

`migration_imports`の`id=checkpoints`で共通段階と独立した進捗を保持する。行INSERT・全値一致・進捗更新は同じbatchで行い、応答喪失時は同一archiveから再開する。完了済み再実行でも行数・値・FK・committed checkpoint参照を再照合する。`checkpoint_import_complete=true`はこの段階だけの完了であり、`execution_complete=false`を維持する。

実PostgreSQLからexportしてworkerd D1へ取り込み、実際のStateGraphで会話の継続、過去checkpointからの分岐、interruptの再開を確認した。legacy TASKS、namespace、Map/Set/bytes、数値version、破損入力の書込前拒否、commit応答喪失後の再開も検証対象とする。本番履歴・リモートD1でのリハーサルは引き続き必要である。


## Embeddingの書込前検証・変換準備

共通importの最初のtarget書込前に、`scene_embeddings` / `scene_embeddings_768`をprivateなシーンspoolへ変換する。動画の所有者は共通videosの正本と照合する。source ID・本文・時刻・evidence type・既存Embeddingを保持し、モデルによる再生成は行わない。1536/768の同じscene IDは独立したmodel spaceとして扱う。

UUID、安全整数のvideo ID、参照動画と所有者、metadataの所有者との一致、重複ID、次元数、有限かつfloat32で表現可能な非ゼロvector、本文込みのstaging予算を検証する。metadataがSQL NULLなら現行検索と同じ空時刻・transcriptを使う。不明なevidence typeや時刻の型は拒否する。ログへ元payloadを出さない。

private SQLiteで所有権・重複を照合するため、全sourceをメモリに保持しない。archive/video/model spaceから決定的なrevisionを作り、live writerと同じ関数でimmutable vector IDを作る。同一archiveの再試行でIDを変えない。

変換準備だけではEmbedding行を`pending_special_rows`から差し引かない。後続のD1シーン投入・照合が成功した場合に差し引き、Vectorize未配信分は別の`pending_vectorize_rows`で報告する。`prepared=true`もD1投入完了も、Vectorize配信完了を意味しない。


## シーン・Vectorize同期outboxのoffline投入

共通行・checkpointの投入後、`importSceneTables`がシーンと既存Embeddingを持つ同期タスクを投入する。video source revision、model spaceごとのpublished run/headも再構築する。同一動画の1536/768はsource revisionを共有し、run/headは独立する。scene IDはsourceのUUIDを維持し、Vectorize IDはimmutable versionにする。

`migration_imports`の`id=scenes`に入力/plan hashとrow cursorを保持する。各シーンのINSERT、公開状態、outbox、全値・所有者のassertion、進捗更新は同じD1 batchに置く。異なる入力、既存の無関係なデータ、進捗競合を拒否する。成功応答を失っても同じアーカイブから再開できる。完了済みの再実行でも全シーン・outbox・公開状態と件数/FKを照合する。

このフェーズの間は公開routeだけでなくcron/index同期Workerも停止する。importはoutboxが未claim・未配信であることを確認するため、配信開始後の再importは拒否する。同じアーカイブを本番稼働後へ重ねて投入する用途には使わない。

成功時は`scene_import_complete=true`と`scenes_imported`を返し、raw Embeddingを`pending_special_rows`から除く。`vectorize_delivery_complete=false`、`pending_vectorize_rows`、`execution_complete=false`は維持する。既存のLangChain同期処理で配信できるが、外部Vectorizeの配信・可視化の照合、検索品質、本番相当の移行リハーサルは別途必要である。すべての移行段階を終えるまで公開サービスへ接続しない。


## legacy visual参照の移行準備

共通importの書込前検証で、videos・video_visual_runs・video_visual_chunksをprivate SQLiteへ読み、run単位の移行計画を生成する。全動画のchunkを一括でメモリに保持せず、1 runの最大600 chunkに限定する。

runのUUID、duration/chunk_count、動画ファイルとの一致とuploaded種別、chunkの所有run・index範囲・連続した全grid・frame_countを検査する。ready runは全chunkが完成し、合計frame_countが正でなければ拒否する。0 frameで完成したchunkと未完成のNULLは区別して保持し、processing/error runの途中経過も保持する。不整合は共通rowのtarget書込前に拒否する。

PostgreSQLのlegacy object keyとD1のversioned object keyは異なるため、DB行のコピーはvisual復元の完了を意味しない。`pending_visual_runs`と`visual_objects_migrated=false`を返す。storage未指定の場合は関係検査・private計画生成までとなる。次節以降のvisualStorageを指定すると、bin/jsonの検証、versionedキーへのコピー、publication manifest/overviewとcleanup台帳の復元まで実行する。全体の切り替え検証が終わるまで移行先を公開しない。


## legacy visualオブジェクトの検証・private stagingとコピー

`scripts/migrations/d1/visual-artifacts.ts`は前節のrun計画と`VisualMigrationSource`を受け取り、完成済みchunkの`.bin`と`.json`を検証する。source実装は最大サイズを読み込み前に適用する契約を持つ。magic/UTF-8/index長、video ID・duration・frame数、chunk内時刻、連続した画像範囲、末尾までの全バイト、JPEGの境界、疎サンプルのoffset/length/時刻/base64とdense画像の一致を検査する。完成した空chunkを保持し、NULLの未完成chunkは読まない。これはJPEGデコーダによる画像全体の検査ではなく、既存wire formatと参照整合性の検査である。

各objectをprivateなローカルファイルへ固定し、内容hashから決定的なversioned keyを生成する。ready runは検証済みchunkからchunk_versions付きmanifestとoverviewを再構築する。manifest/overviewは既存runtimeのサイズ・件数予算を満たすものに限定する。object inventory全体にもhashを付け、画像や元JSONをログに出さない。

`copy-visual-artifacts.ts`は明示したoffline destinationへコピーする独立エンジンである。privateな計画コピーを固定し、inventory全体のhashと各fileのhashを検証する。destinationは原子的なcreate-onlyを実装する契約を持つ。既存keyの内容が異なる場合は上書きせず拒否し、同じ内容なら再利用する。PUT後も内容を再読込して照合する。commit応答喪失は同じstagingからの再実行で回復する。

成功の`visual_object_copy_complete=true`はオブジェクトのコピー段階だけを意味する。`visual_objects_migrated=false`を維持する。source/destination接続を注入するライブラリとして提供し、R2 bindingアダプターとD1のobject_version/publication_version/cleanup台帳への反映に対応する。リモートR2接続CLIは未実装である。共通importはvisualStorageを指定した場合だけこの処理を実行し、未指定なら引き続きpending_visual_runsを返す。sourceのPGとmedia writerを停止/drainした同じ移行スナップショットで使用し、公開route・schedulerを再開しない。


## visual参照・cleanup台帳への反映とR2 binding

`importCommonTables`の`visualStorage`へsource/destinationを明示すると、共通行・checkpoint・scene投入後に`importVisualObjects`を実行する。`r2-visual-storage.ts`は既存VideoQと同じ`media/`プレフィックスを付け、サイズ制限付きstream読込と条件付きcreate-only PUTを実装する。条件付き操作は[Cloudflare R2仕様](https://developers.cloudflare.com/r2/api/workers/workers-api-reference/#conditional-operations)に基づき、ローカルworkerdでも上書き拒否を確認している。

```ts
await importCommonTables(database, archivePath, manifest, {
  offlineStaging: true,
  visualStorage: {
    source: r2VisualMigrationStorage(sourceBucket),
    destination: r2VisualMigrationStorage(destinationBucket),
  },
});
```

移行先サービスのVIDEO_BUCKETが参照するbucketをdestinationに選ぶ。sourceと同じbucketも指定できるが、従来キーは変更せず、新しいversionedキーだけをcreateする。この例はbindingを渡すNode移行ライブラリの呼び出しであり、公開HTTP endpointやリモート接続CLIではない。

`migration_imports`の`id=visuals`はarchiveとobject inventoryのhashを固定する。別入力や再実行時のsource内容変更を拒否する。R2へ書く前にvisual_object_attemptsへpendingを記録し、コピー内容を照合してからchunk参照/台帳を同じD1 batchで公開する。ready runのpublication_versionは全chunk参照がそろった後で反映する。途中PUT失敗・DB応答喪失は同じarchive/sourceで再開できる。

成功時は`visual_objects_migrated=true`、`pending_visual_runs='0'`となる。`execution_complete=false`は維持する。途中失敗時はofflineを保ち、route・index/visual cleanup schedulerを再開しない。完了済み再実行でもdestination内容・D1参照・台帳・件数を照合する。従来のsourceオブジェクトは削除しない。

検証では実PostgreSQL export→共通D1 import→ローカルR2 copy/publicationを接続し、別のD1/R2統合試験で既存readFocusFramesが移行後のフレームを読むことを確認する。これはリモートR2、実本番履歴、検索品質や全体E2Eの検証とは区別する。


## Vectorize配信後の内容照合

Vectorizeのupsertは非同期であるため、outboxのcompleted_atは書き込み要求の受付を表す。[Cloudflare Vectorize API](https://developers.cloudflare.com/vectorize/reference/client-api/)のgetByIdsを使い、元アーカイブのEmbedding・metadataと取得結果を別途照合する。

`verifyArchiveSceneDelivery(database, archivePath, manifest, indexes, {offlineStaging: true})`は元archiveをprivate copyへ固定して全体検証し、sceneの期待値を再構築する。共通importを再実行せず、配信済みoutboxをリセットしない。`verifyMigratedSceneVectors`が、profileごとのbindingの次元数を確認し、最大20 IDずつgetByIdsを呼ぶ。両次元を混ぜない。

元Embeddingと返却値をfloat32精度で比較し、user/video/scene/revision/vector IDとnamespaceを照合する。D1の本文・時刻・evidence type・所有者・scene/taskの対応、outbox完了状態も確認する。全provider呼出後にD1を再照合し、scene import receiptと件数も再確認する。検証中のprivate入力を固定し、元pathの後変更に影響されないようにする。値・ID・providerの生エラーは結果ログに含めず、checked/verified/missing/mismatched/pending_tasksを返す。

`vectorize_delivery_complete=true`は対象全件の値/metadataがID指定で取得でき、D1の配信状態も一致した場合だけ返す。未反映や不一致ではfalseを返す。これだけでは近似検索への反映、Recall/ランキング、余分なremote vectorの不存在、性能や全体E2Eを証明しない。`search_quality_verified=false`と`execution_complete=false`を維持する。公開サービスは検証中も停止する。

index引数は`{768: vectorize768, 1536: vectorize1536}`のbindingである。実アカウントへの接続CLIは引き続き未実装で、今回のprovider照合試験はfixtureを使う。実Vectorizeでの遅延反映・精度・float32値の確認は本番切替前の検証対象に残る。


## 専用リモートstagingの段階別コマンド

`wrangler.d1-staging.jsonc`の既知DB ID・account・binding/index名・404専用main・非公開routesを起動前に固定照合する。任意configやproduction環境への切り替えオプションはない。先に入力archiveをprivate copyへ固定して全件検証・変換準備し、その後でremote bindingへ接続する。

```sh
npm run db:d1:staging:migrate --workspace @videoq/api -- \
  --mode import --input /absolute/private/path/source.videoq-export.ndjson
npm run db:d1:staging:migrate --workspace @videoq/api -- \
  --mode deliver --input /absolute/private/path/source.videoq-export.ndjson --max-tasks 100
npm run db:d1:staging:migrate --workspace @videoq/api -- \
  --mode verify --input /absolute/private/path/source.videoq-export.ndjson
```

importは既存の空target/同一archive再開・全値/FK/sequence/checkpoint/scene照合を使う。deliver/verifyは同じarchiveの完了済みscene receiptがなければ拒否する。deliverは最大指定件数（1〜10000）までのoutbox処理で、失敗/lease loss/処理可能taskなしで停止する。バックオフ中や件数上限を超えるtaskは後続実行で処理する。受付成功は配信可視化の証明ではないため、verifyを別に実行する。

verifyでvectorize_delivery_completeがfalseの場合、終了コード2と件数結果を返す。deliverの失敗/lease lossも2とする。設定・入力・実行エラーは1とし、元データやprovider生エラーを出さない。0でもphaseごとの成功に限定され、execution_complete=falseを維持する。

この固定staging configにはR2 bindingがないため、visual runを含むarchiveのimportは接続前に拒否する。専用ライブラリのvisualStorage経路でobjectを移すか、DB先行リハーサルとして明示的に`--allow-pending-visuals`をimportにだけ付ける。後者はvisual_objects_migrated=falseとpending_visual_runsを残し、公開/本番切り替えに使わない。

実行中はtargetをofflineに保ち、remote結果が遅延している場合は同じarchiveでverifyを再実行する。配信開始後にimportを再実行してoutboxを初期化しない。このCLIは専用stagingの移行操作を実行する機能であり、実本番データ・品質・E2E/復旧の合格証拠ではない。


## 最新main統合後の検証範囲（2026-11-13）

現行の対応はPostgreSQL 58テーブル（共通56、Embedding特殊処理2）。D1用0018は教員接続と質問者スナップショットの追加であり、既存のPostgreSQL履歴0062〜0064を維持したうえで、未公開だったmultipart制約変更を0065として生成した。

ローカルのworkerd D1と使い捨てPostgreSQLを使用した永続化テストは1,346件が成功した。別のAPI回帰テストは2,182件、workerdのAPIテストは59件、Python Workerは594件が成功した。実サービス・外部認証・ストレージ等を必要とするopt-inテストにはskipがあり、この件数を本番E2Eや本番データ移行の完了とは扱わない。全workspaceの型チェック、API ESLint、Nodeビルド、両DBのDrizzle履歴検査も成功した。

実Cloudflareでは、旧schema（0017まで）のv1記録を保持し、別のv2 DB/indexに0018までを適用して58テーブル・合成15行で再検証した。共通56テーブルと13採番状態の移行・再投入、2ベクトルの値照合、教員/質問者情報の取得、認証、D1 Time Travel後のhash一致が成功している。旧receiptやbookmarkを新targetへ流用しない。本番切り替えの前提には、未マッピング27テーブルの保持方針、AWS内での保護された一貫スナップショット取得、実データの整合性・認証・検索品質・性能・費用の検証が引き続き残る。

## 同一Embeddingによる検索比較

`db:d1:staging:evaluate-search`は、事前生成した同一Embedding・userId・動画選択・limitを、PostgreSQLと固定v2 stagingのD1/Vectorize検索契約へ渡す。Embedding APIやLLMは呼び出さない。PostgreSQLの通常検索も同じprecomputed-vector実装を使用する。接続初期化後に各検索呼び出しを計時し、backendの呼出順を交互にする。

入力JSONはprivateな通常ファイル（0600等）とし、次のTypeScript相当の構造を保存する。`existingQueryEmbedding`は対象モデルで事前生成した768/1536個の有限値で、ゼロベクトルは不可。本文・質問や所有者IDをpublic fixtureへ書き出さない。

```typescript
const cases = {
  version: 1,
  cohort: "production-rehearsal", // 合成試験では "synthetic"
  corpusSha256: verifiedArchive.archive_sha256,
  model: "text-embedding-3-small",
  dimensions: 1536,
  samples: 3,
  cases: [{
    queryEmbedding: existingQueryEmbedding,
    userId: ownerId,
    videoIds: selectedVideoIds,
    limit: 20,
  }],
};
```

同じ凍結コーパスのPostgreSQL rehearsal copyを用意し、writerを停止・drainする。`DATABASE_URL`は既存の承認済み経路で環境へ渡す。保護された本番backup/migration credentialをローカルへ取り出すためのコマンドではない。リモートPostgreSQLには`sslmode=verify-full`を要求し、評価用セッションにはread-onlyとstatement timeoutを設定する。`EMBEDDING_PROFILE`/`EMBEDDING_MODEL`（768では専用`EMBEDDING_BASE_URL`も）を入力モデルと一致させる。

```sh
PERSISTENCE_EVALUATION_SOURCE_OFFLINE=1 \
  npm run db:d1:staging:evaluate-search --workspace @videoq/api -- \
  --input /private/rehearsal/search-cases.json \
  --archive /private/rehearsal/source.videoq-export.ndjson \
  --output /private/rehearsal/search-report.json
```

archiveを全件検証・private copyへ固定し、そのhashとcaseのcorpus hashを照合する。接続先は固定staging configだけで、production/任意configの指定はない。検索前に、archiveの全sceneのD1所有関係・本文・revisionとVectorize値・metadata・配信完了receiptを再照合する。不一致や未配信なら評価しない。全処理はsource/targetに対してread-onlyであり、完了済みoutboxを再初期化しない。出力は0600で原子的に作成し、既存レポートを上書きしない。

レポートはPG top-kとの平均重複率、順位までの完全一致数、空結果、重複sceneを考慮した件数、両backendの検索呼出p50/p95/p99を集計する。PGが空の組は完全一致率を水増しするための「Recall=1」とせず、重複率の分母から除外する。sceneはvideo/time/evidence type/本文で同一性を比較し、タイトルは比較キーから除く。結果本文・Embedding・所有者IDは出力しない。

これは人手の正解ラベルに対するRecallではなく、PGとの検索結果の一致を測る道具である。sourceの凍結assertionだけに頼らず、PostgreSQLでread-only/repeatable-read snapshotを取得し、同じsnapshotから全マッピングテーブル・補助checkpoint・Drizzle履歴を再exportして照合する。テーブル/列/主キー構成と正規化済み全行hashが一致した場合だけ、そのsnapshotを検索接続へimportして比較する。root schema名は隔離sourceからpublicへの復元を考慮して正規化するが、補助schema名は変更しない。不明テーブル、値や構成の違い、期限切れsnapshotは拒否する。snapshot検索の接続はidle evictionを無効にし、接続断/交換が起きた場合は新しい値へ黙って切り替えず、評価全体を失敗させる。

成功時の`source_snapshot_equality_verified=true`は、`source_verification_scope`に示した正規化済み行・列/主キー構成・Drizzle履歴の範囲に限る。シーケンス状態はMVCC対象ではなく、その他のcatalog制約・権限・外部オブジェクトも照合対象外なので、それぞれ別の検証を必要とする。保護された本番接続情報のローカル取得は引き続き禁止する。代表クエリ集合・モデルの生成元・認可の攻撃ケース・承認済み閾値も別途そろえる。接続確立・source全件照合・Embedding・API/LLMを除く時間を、E2Eやcold-startの改善値として扱わない。`acceptance_criteria_applied=false`と`execution_complete=false`を維持し、本番切り替えの合格を自動宣言しない。snapshotの共有条件は[PostgreSQL 17の公式仕様](https://www.postgresql.org/docs/17/sql-set-transaction.html)に従う。

2026-11-13に、source snapshot照合導入前のCLI（`2eaf8bf4`）を、既存の合成v2 staging（各次元1ベクトル）とローカルPostgreSQLで実行した。各次元でowner/別ownerの2ケースを3回ずつ比較し、ownerの結果が一致し、別ownerは両方で空だった。両次元ともarchiveの2ベクトル全値照合も通過した。これは実Vectorizeを通る評価経路の疎通確認であり、代表的なANN品質・本番性能・本番source整合性の証拠ではない。

現行CLIはsearchテーブルだけの部分コピーを拒否する。上記の旧疎通記録は`source_snapshot_equality_verified=false`のまま保存し、新しい証明として読み替えない。現行のsource照合とsnapshot検索は、実PostgreSQLで同件数の値変更、主キー構成変更、不明テーブル、checkpointバイナリ変更、期限切れ、idle eviction時間を超える待機、接続強制終了を検証した。さらに58テーブル・合成15行を別のローカルPostgreSQLへ復元し、75個の外部キーを投入後に検証した。その完全なsource copyと既存remote v2 targetを使い、現行CLIも768/1536両方で再実行できた。全行・構成の一致を確認したsnapshotを検索へ共有し、各6組の結果比較が成功した。sourceだけを同件数のまま変更すると、remoteへ接続せずreportも公開しないことを実CLIで確認した。この追加結果も合成試験に限られ、実データの全経路リハーサル・品質/性能基準の確認は引き続き必要である。
