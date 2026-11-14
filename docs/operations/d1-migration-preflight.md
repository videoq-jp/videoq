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

実Cloudflareでは、旧schema（0017まで）のv1記録を保持し、別のv2 DB/indexに0018までを適用して58テーブル・合成15行で再検証した。共通56テーブルと13採番状態の移行・再投入、2ベクトルの値照合、教員/質問者情報の取得、認証、D1 Time Travel後のhash一致が成功している。旧receiptやbookmarkを新targetへ流用しない。旧27テーブルは完全バックアップで保管し、現行アプリだけD1へ移す方針が承認され、2026-11-14にAWSでの保全・取得・独立復元を完了した（末尾の保全記録を参照）。明示的な除外一覧を実装し、実データのローカルD1取り込みまで確認した。リモートD1、認証・検索品質・性能・費用、Vectorizeとvisualオブジェクトの検証は引き続き残る。

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

## 旧Django／OAuthテーブルの扱い（2026-11-14決定）

ユーザーは、完全バックアップと復旧確認を済ませた後、旧Django／OAuth関連27テーブルを保管し、現行アプリのデータだけD1へ移す方針を選択した。旧テーブルのD1スキーマ追加や、稼働中の旧データ削除はこの方針に含まれない。

この決定だけでは、移行元の未対応テーブルを無視できない。まず全4スキーマを含む完全なPostgreSQLバックアップを私有のバージョン付き保管先に保存し、同じバージョンを取得・復元して、全テーブルの件数と参照整合性を照合する。その復元済みデータから現行アプリ対象を抽出する段階で、保全証跡と結び付けた明示的な除外一覧を検証する必要がある。

27件という過去の観測件数だけを条件にした除外、名前の接頭辞による一括除外、保全証跡のない除外は認めない。最終スナップショットで除外対象を再照合し、想定外の追加・欠落・変更があれば停止する。認証・セッション・OAuth情報を含むバックアップは私有のまま扱い、本文・トークン・秘密値をログへ出さない。

2026-11-14、修正PR #1443の通常CI・CodeQL・マージキュー・main CI・AWS自動デプロイ成功後、[Operations #43581386624](https://github.com/videoq-jp/videoq/actions/runs/43581386624)で全4スキーマの完全バックアップを隔離DBへ復元し、私有のバージョン付きS3へ保存した。固定したmanifest版からdumpを取得し、SHA-256・サイズ・権限を検証後、ネットワークを持たない別のDBへ再復元した。全91テーブルの件数が一致し、未検証制約は0件だった。復元イメージはPostgreSQL 17.12で、旧17.11クライアントによる内部列属性`pg_attver`の非互換を修正している。

検証後は新規保存フラグと保存権限を無効にし、保存済み2オブジェクトの版、S3、定期保守の有効状態、レビュー済みコード版を維持した。[保全・復元の集約証跡](evidence/backup-preservation-recovery-2026-11-14.json)には秘密値・レコード・私有receiptを含めない。

完全バックアップの保全と復旧確認を完了し、保全証跡とハッシュに結び付けた明示的な除外一覧を実装した。設定を渡さない場合や、一覧外の未対応テーブルは引き続き拒否する。現行アプリのD1 exportとローカル取り込みを確認したが、本番切り替えは未実施であり、受け入れ基準の完了は意味しない。


## 保全済み旧テーブルの明示的な除外

`apps/api/scripts/migrations/d1/legacy-source-tables.json`は、保全バックアップで観測した旧27テーブルの名前だけを列挙する。件数や接頭辞で未知テーブルを自動承認しない。実行時にはこの一覧を0600の私有ファイルへコピーする。

復元済みのローカルPostgreSQLのwriterを停止し、`DATABASE_URL`を環境で渡す。元の本番DB認証情報を取得しない。まず`d1-preserve-legacy.ts --backup-dir <private-retrieved-backup> --tables <private-explicit-list.json> --output <private-policy.json>`でポリシーを作る。取得時のmanifest・receipt・dumpのハッシュと復元結果、全4スキーマのテーブル集合と件数を照合し、旧テーブルの列・制約・索引・トリガー・全行のハッシュを私有ポリシーへ記録する。receiptは承認済み運用経路が作成した証跡であり、暗号署名による第三者の証明ではない。

次に`d1-export.ts --output <private-source.videoq-export.ndjson> --preserved-policy <private-policy.json> --backup-dir <private-retrieved-backup>`を実行する。指定したポリシーは毎回保全ファイルと照合し、exportのread-only snapshot内で除外対象を再ハッシュする。追加・欠落・構造変更・同件数の行変更、現行アプリやcheckpointテーブルから旧テーブルへの外部キーがあれば停止する。旧テーブル本体とその所有シーケンスはD1 archiveへ含めず、保全との対応情報をheaderへ残す。現行アプリの未知テーブル・列・型変更の拒否、archive全体の検証と本番切り替えの受け入れ条件は維持する。

このポリシーは、その保全バックアップから復元したコピーに対して作成する。最終移行では新しい完全バックアップと取得・復元検証に対してポリシーを作り直す。以前のポリシーを別のスナップショットへ流用しない。旧テーブルの削除や、稼働中のDBへ変更する処理はない。


2026-11-14の実バックアップで、この手順による62テーブル・9,854行のarchive生成と全体検証に成功した。ローカルworkerd D1へ56共通テーブル、2,190シーン、643 checkpointと関連blob/write、13採番状態を取り込み、同じarchiveの再投入も成功した。外部キー違反は0件だった。[集約証跡](evidence/d1-preserved-production-data-local-rehearsal-2026-11-14.json)を参照する。5件のvisual run、2,190ベクトルの実Vectorize配信、実認証・品質・性能・料金の確認は残る。

検索評価CLIでも同じ`--preserved-policy`と`--backup-dir`を対で指定する。archive headerと異なるポリシーや、除外した行が変化したsource copyは、リモートtargetへの接続前に拒否する。

更新後のツールでも同じ不変dumpから新しく復元し、除外ポリシーとarchiveを再生成した。62テーブル・9,854行について、archiveとPostgreSQLの同一read-only snapshotが正規化後の全行・列・主キー構成・Drizzle履歴で一致し、除外27テーブルの構造・全行ハッシュの再照合も成功した。これはsource側の対応確認であり、リモートD1・Vectorizeやvisualオブジェクトの検証を代替しない。


## 実データ用のv3リハーサル

`wrangler.d1-staging.jsonc`は実バックアップ用のv3 DB（`373d6ca5-2796-460d-8ab1-e644de46bb3c`）と`videoq-scenes-migration-v3-{768,1536}`を固定する。v2の合成検証設定は`wrangler.d1-staging.v2.jsonc`に保持する。旧DB・index・receiptや復旧bookmarkをv3の証拠として流用しない。公開route、workers.dev、preview URL、アプリのsecretsは設定しない。

合成データ用の`db:d1:staging:smoke`、`db:d1:staging:recovery`、opt-inの`d1-auth.remote.integration.test.ts`は、v2設定と`validateSyntheticStagingTarget`を固定で使用する。v3への既定設定変更後も、合成試験が実データのv3へ書き込まないよう、両検証器は互いの設定を拒否する。任意のconfigやDB IDを指定するオプションは設けない。2026-11-14にv2で認証・所有権の2試験、768/1536両次元の検索と別所有者の拒否、追加した全合成データの削除を確認した。その終了後に合成復旧用snapshotのprepareと独立verifyも成功した。新たなTime Travelは実施していない。[再確認証跡](evidence/d1-v2-synthetic-target-reverification-2026-11-14.json)を参照する。

初期取り込みは`db:d1:staging:migrate -- --mode import --input <private archive> --allow-pending-visuals`で行う。writerを停止した専用環境でのみ実行し、配信は取り込み完了後に開始する。シーンは最大5行かつ入力512 KiB程度の小さな単位で、各行の進捗チェック・参照・outbox更新を同じ原子的batchへまとめる。応答喪失時も確定済み進捗から再開でき、全行の値チェックは省略しない。

完了済みの共通データや会話履歴を再投入せずシーンだけを再開する場合は、元の処理の終了を確認してから`--mode resume-scenes --input <同じprivate archive>`を使う。この経路は、同一archiveに対応する共通データ・会話履歴の完了記録を確認し、保存されたシーン行位置から続ける。同時に複数のimporterを起動しない。取り込み完了後のVectorize配信では4件までの並列処理を使い、リース・immutable ID・所有権の再確認を維持する。通常の同期処理は既定の並列数1を維持する。

visualは`db:d1:staging:migrate-visuals -- --input <同じprivate archive>`で別フェーズとして実行する。`wrangler.d1-visual-staging.jsonc`は、読み取り元の`videoq-media-prod`と、書き込み先の私有`videoq-media-migration-staging-v3`を明示する。sourceへはreadだけを公開し、既存オブジェクトを書き換えない。コピーはcreate-onlyで行い、再取得した内容をハッシュ照合してからD1の参照とcleanup台帳を確定する。visual用のremote proxy名はDB用と分離する。

2026-11-14、実バックアップの5 visual runに対応する10オブジェクトのコピーとD1参照移行が成功した。これら5件は移行元ですでに`error`状態であり、その状態と存在する部分成果物を保持した。移行によってreadyへ変更したり、既存の処理失敗を解消したことにはしない。コピー先のr2.dev公開は無効で、カスタムドメインは未設定である。


## 実データ用D1の復旧演習

既存の`db:d1:staging:recovery`は小さな合成データ専用である。v3の実データには`db:d1:staging:recovery-real`を使う。引数は`--mode prepare|mutate|restore|verify --state <private state.json> --archive <同じprivate archive>`で、`PERSISTENCE_RECOVERY_TARGET_OFFLINE=1`を明示する。接続先はv3の固定DBだけであり、任意のconfigやDB IDを渡せない。

Vectorize配信を含むすべてのimporter・writerの終了を確認してから実施する。ツールも、同一archiveの各フェーズ完了記録、未完了のoutbox・リースがないことを確認する。`prepare`は、全元テーブルのSQL exportを私有ディレクトリで2回取得・ハッシュ照合し、スキーマ・採番値・bookmarkを私有stateへ記録する。export対象外にする`mutation_receipts`は、スキーマを照合し、空であることを別途確認する。内部`_cf_*`表やSQLiteのプランナー統計は比較対象に含めない。

`mutate`は顧客データを変更せず、`mutation_receipts`に専用nonceを持つ1レコードだけを作る。`restore`は、それ以外の全データ・スキーマ・採番がbaselineと一致し、検証レコードがこのstateに属することを確かめてから、固定DBを保存bookmarkへTime Travelで戻す。戻した後も全ハッシュと検証レコード消失を確認する。`verify`で独立に再照合できる。応答喪失後にすでにbaselineへ戻っている場合は、破壊的なrestoreを再発行せず、API応答確認の有無を区別して返す。

SQL exportは認証情報を含むため私有のまま扱い、内容や署名付きdownload URLをログへ出さない。元のNeon・R2や本番D1への操作は行わない。演習失敗時もtargetを公開せず、私有stateと作業ファイルを保って原因を調べる。Time TravelはDBをその場で上書きするため、Vectorize・R2への処理を同時に動かさない。仕様は[Cloudflare公式Time Travelドキュメント](https://developers.cloudflare.com/d1/reference/time-travel/)を参照する。

2026-11-14、v3のVectorizeで2,190件すべての書き込み受付とD1 outbox確定が成功した。続けて全件を取得し、元のfloat32ベクトル値、所有者・動画・シーン・revision・vector ID、および対応するD1本文・所有関係を照合した。欠損・不一致・未完了タスクは0件だった。これは格納値の一致であり、ANN検索の可視化や代表質問での検索品質は別途確認する。

同じ実データのD1でも、68テーブルの復旧演習が成功した。元データのSQL export（180,665,549 bytes）のハッシュを2回照合した後、専用metadataレコードだけを作成し、保存bookmarkへのTime Travelが成功した。復旧後のSQL export・スキーマ・採番の一致とmarker消失を確認し、独立したverifyでも再確認した。顧客レコード、元のNeonとR2は変更していない。[v3実データ証跡](evidence/d1-v3-preserved-data-rehearsal-2026-11-14.json)を参照する。本番アプリの切り替え、実認証/E2E、代表検索品質、性能・費用の受け入れは未完了である。

実検索でも40動画の既存ベクトルから元シーンを取得でき、別所有者の40ケースはすべて空だった。同じdumpのPostgreSQLコピーとの比較では、正負80ケースを各3回、計240組で実行した。上位20件の集合はすべて一致し、順位は237組で完全一致した。残り3組も取得内容は一致した。比較前にsourceの全行・列構成とtargetの全ベクトルを再照合している。既存ベクトル由来の試験であり、代表的な人の質問による検索品質の証明には使わない。

repository-call-onlyのp95は、ローカルPostgreSQLで15.33 ms、開発用remote binding proxy経由のD1で528.56 msだった。接続条件が異なるため、本番APIの性能比較や合否判定には使わない。Cloudflare実行環境内で条件をそろえた測定と、品質・料金の受け入れ条件は引き続き必要である。

認証は共通のテスト署名鍵を使い、有効な既存19セッション（2ユーザー）の返却内容をPG/D1で全件比較し、一致した。session refreshを無効にし、D1ではSELECT以外を拒否、PostgreSQLでは読み取り専用設定を使用した。未知セッションと別鍵の署名は両方で拒否され、D1への変更試行は0件だった。オンプレ側authにはCloudflare bindingを渡していない。本番cookieの署名鍵継承や外部OAuthの実ログイン確認は、切り替え前の条件として残す。

## 同一Worker内のDB読み取り比較

2026-11-14、専用WorkerのRPC内で、既存Hyperdrive経由の稼働中Neonと隔離v3 D1を比較した。既存の所有者と動画IDによる固定のパラメーター付きSELECTだけを使用し、PostgreSQLではREAD ONLYトランザクションとタイムアウトを設定した。接続文字列はWorker内だけで使用し、ローカルへ取得していない。HTTP fetchは常に404で、公開route、workers.dev、preview URL、アプリsecretsは設定しない。

5動画を各5回、3 invocation、合計75組で交互に測定し、全組で両DBから同じ所有対象を取得できた。nearest-rank方式のp95はNeon 192 ms、D1 210 msだった。PostgreSQLの接続・読み取り専用設定には別途540〜583 msかかっており、読み取り時間から分離して記録した。この測定ではD1の性能改善は実証されていない。Workerの実行地域、Hyperdriveのキャッシュ条件、Neonのcold状態は制御していない。少数の主キー検索であり、主要APIのE2E・同時負荷・RAG品質の合格判定には使わない。[測定証跡](evidence/d1-v3-native-edge-read-benchmark-2026-11-14.json)を参照する。

実装は`edge-benchmark-worker.ts`の`MigrationBenchmark.measure`で、入力は`{version:1,cases:[{videoId,userId}],samples}`、1 invocationにつき最大25組に制限する。応答は件数と時間だけで、識別子・行内容・DBエラーを含めない。`validateEdgeBenchmarkTarget`は専用Worker名、既存Hyperdrive ID、v3 D1 ID、非公開設定を固定し、未知の設定項目やsecrets・route追加を拒否する。実行時のケースとRPC呼び出し用設定は私有のまま保持する。再実行は同じ固定設定の検証とdry-run後に限り、任意SQLを受け付ける機能や公開の呼び出し経路を追加しない。

Freeプランでは`limits.cpu_ms`を指定できず最初のデプロイが拒否されたため、指定を除去し、プラン変更せず測定した。測定後は一時Workerを削除し、既存Hyperdrive、稼働アプリ、D1のデータは保持する。

地域条件も追加確認した。[Placementの仕様](https://developers.cloudflare.com/workers/configuration/placement/)ではRPC・named entrypointに配置設定が適用されないため、追加測定には`wrangler.d1-edge-benchmark-tokyo.jsonc`の専用HTTPサービスを使用した。公開routeは持たず、毎回新しく作る256-bitの一時capabilityも要求する。認証前は本文・DBへアクセスせず、本文16 KiB・最大25組の制限と固定SQLを維持する。capabilityは本番の認証鍵とは別で、私有stdinから専用Workerだけに設定し、測定後はWorkerごと削除した。

`placement.region=aws:ap-northeast-1`を指定し、3回すべての応答で`cf-placement=remote-NRT`を確認した。75組のp95はNeon 84 ms、D1 89 ms、PostgreSQLの接続・READ ONLY設定は別途225〜250 msだった。この主キー検索でもD1のread-call単独の改善は実証されていない。接続開始時間を含む主要API、同時負荷、cold状態、レプリカ利用時の整合性・性能は別に評価する。[東京近傍の測定証跡](evidence/d1-v3-tokyo-edge-read-benchmark-2026-11-14.json)を参照する。最初のupload後にCloudflareのWorker取得APIが10007を返したが、versions一覧でupload済みを確認し、同じ設定の再デプロイが成功してから測定した。

代表質問での既存Embeddingモデル評価については、現在の運用者のAWS認証でSTSの短命workload IDを発行できることを確認したが、設定済みOpenRouter federation policyとの交換は`400 invalid_grant`だった。長期APIキー、DB秘密情報、別roleの取得や、信頼設定の変更は行っていない。トークンはメモリ内だけで扱い、私有receiptにも保存しない。[公式仕様](https://openrouter.ai/docs/guides/overview/auth/workload-identity-federation)上、このエラーだけではポリシーの有効状態、subject等の不一致、署名や期限のどれが原因かは特定できない。代表質問によるモデル評価は未実行として扱い、既存ベクトル由来の比較を代わりの合格証拠にはしない。

## 読み取りレプリカとプライマリbookmarkの評価

2026-11-14、隔離v3だけでread replicationを一時的に`auto`へ変更し、東京近傍の専用HTTP Workerで測定した。[D1の仕様](https://developers.cloudflare.com/d1/best-practices/read-replication/)上、通常のDB bindingへのqueryはプライマリへ送られ、レプリカにはSessions APIが必要である。業務アダプターの接続方法や本番DB設定は変更していない。

検証器は、各invocationでまず`withSession('first-primary')`のbatchで全対象の動画ID・所有者を照合する。そのsessionのbookmarkを新しい読み取りsessionへ渡し、少なくともその時点以降のデータを読む。所有権不一致やbookmark欠落は失敗させ、無制約のsessionへフォールバックしない。bookmarkや行内容は応答・公開証跡へ含めない。これは認証済みユーザーの業務APIではなく、別の一時capabilityで保護したDB測定専用操作である。

有効化直後の初回75組では69回がレプリカで、D1のp95は116 ms、Neonは90 msだった。追加試行は開始前に3 invocationをwarmup、続く9 invocationを測定対象とし、各25組・合計300組を記録した。warmupを含むD1のp95/p99は34/124 ms、Neonは89/96 msだった。warmup後の225組は全件レプリカで、D1のp50/p95/p99は21/31/51 ms、Neonは82/90/96 msだった。全12応答で`cf-placement=remote-NRT`を確認した。

プライマリでの所有権確認には各invocationで別途76〜92 msかかっており、31 msをAPI全体の時間として扱わない。PostgreSQLの接続と検証用READ ONLY設定の時間も別に記録する。起動直後を含むp99、主要APIのE2E・同時負荷・認証失効や所有権変更後の動作は未合格である。古い認可状態でアクセスが通る変更や、全repositoryの無条件なレプリカ化は採用しない。

各試行は元の`disabled`を確認してから開始し、終了時に設定を戻してGETで再照合した。一時Workerとcapabilityも削除した。最後に既存の実データ復旧stateに対して独立verifyを行い、全元テーブルのSQL export、スキーマ・採番のハッシュ一致、probe不在を確認した。新たなTime Travel restoreは行っていない。[全試行・warmup・復旧確認の集約証跡](evidence/d1-v3-bookmarked-replica-benchmark-2026-11-14.json)を参照する。

## Python署名クライアントとnative workerdのHTTPS統合

`npx vitest run test/persistence/worker-python-native.d1.integration.test.ts`は、本番のPython `call_internal_api`から、ローカルHTTPSを経由してworkerd上の本番Hono内部routeへ接続する。D1には独立した実マイグレーション履歴を適用し、Node上でHonoを直接呼ぶ試験とは別に、HTTP・署名・UTF-8・runtimeの境界を確認する。

PythonはWorkerの要件に合わせ3.12以降を必須とし、ローカルの`apps/worker/.venv/bin/python`があれば使用し、なければ`python3`を使う。CIのHono jobは`.python-version`のPythonを導入済みであり、この試験をskipしない。OpenSSLも必要である。毎回試験用CAとSAN付きサーバー証明書を生成し、Pythonの標準信頼contextに読み込まれたことと、Node側でのサーバー証明書fingerprint一致を確認する。TLS検証を無効にせず、終了時にruntime・証明書・鍵を破棄する。子プロセスには試験に必要な環境変数だけを渡し、外部通信は拒否して件数0を検証する。

2026-11-14、ジョブの重複・競合・heartbeat・再試行と旧lease拒否、無効署名の拒否、利用枠確保の冪等性、日本語・絵文字を含む字幕の保存と再配送時の上書き防止、別所有者のstage拒否、シーン公開とoutbox登録が成功した。ベクトル配信が終わっていない間は動画を`indexing`、finishを`pending`のまま維持し、配信済みとして扱わない。関連4ファイル30テスト、API型検査、変更TSのLintも成功した。[統合証跡](evidence/d1-python-native-https-integration-2026-11-14.json)を参照する。

この試験は合成入力での永続化経路の確認であり、LLM・実Vectorize・SQS・Lambdaを呼ばない。デプロイされた動画処理全体、代表質問のRAG品質、本番cookie・OAuthの合格を代替しない。

## 実データ容量と料金条件の再確認

2026-11-14のv3再取得値はD1 109,314,048 bytes、1536次元2,190ベクトル、768次元0件だった。以前のDB物理サイズの観測値とは別時点の値として記録する。ベクトルの保存次元数は3,363,840である。[D1制限](https://developers.cloudflare.com/d1/platform/limits/)の単一DB上限はFree 500 MB、Paid 10 GBで、現時点のv3 DBは収まる。[Vectorize料金](https://developers.cloudflare.com/vectorize/platform/pricing/)の保存次元枠はFree 500万、Paidの内包分1,000万であり、このコーパス単独では内包範囲に収まる。枠は他環境と共有されるため、アカウント全体の余裕を保証するものではない。

同日のv3の24時間値は641,509行read、42,683行writeで、[D1 Freeの日次枠](https://developers.cloudflare.com/d1/platform/pricing/)である500万read、10万writeより少ない。ただし移行・照合・復旧演習のアクセスであり、通常運用量やピーク負荷の予測には使わない。

現在の2,190件を固定し、1536次元の検索呼び出しだけを月10万回行う例では、Vectorize公式式によるquery次元は156,963,840となる。Paidの月5,000万次元内包分を差し引いた超過料金は約1.07 USD、保存次元超過は0 USDである。同じ固定コーパスだけで他の利用がなければ、Freeの月3,000万query次元に収まる呼び出しは17,341回、Paid内包分では30,362回が計算上の目安となる。実際のアプリ要求から複数回検索する場合は、その呼び出し回数で計算する。

この例にWorkersの契約・request・CPU、R2、AWS、LLM、S3保全、移行中のNeon併存費用は含めていない。[Workers料金](https://developers.cloudflare.com/workers/platform/pricing/)とVectorize個別料金ページには利用可能プランの記述に差があるため、実アカウントの契約・課金対象は別途確認する。プラン変更は実施していない。実トラフィック、増加率、現在のNeon費用、月額上限が未確定であり、費用の受け入れは未完了とする。[計算条件と集約証跡](evidence/d1-v3-capacity-cost-assessment-2026-11-14.json)を参照する。

### 代表質問評価の認証経路（未実行）

2026-11-14、利用者から「検証環境はないかもしれない。本番はフェデレーション認証で接続している」と確認した。接続済み検証環境の存在は未確認であり、運用者IDの交換失敗から本番ワークロードの認証失敗を推定しない。

次の実装候補は、本番で許可されている既存ワークロードの内部で、モデル呼び出しだけを行う隔離評価処理である。評価処理は通常の動画処理・課金・利用枠更新・キュー配送を起動せず、固定した既存モデル・次元数で代表質問のEmbeddingを一度生成し、同一ベクトルを両検索実装へ渡す。質問・検索対象・期待シーン・生成ベクトルは私有成果物とし、公開するのは集計結果だけとする。認証トークンはメモリ内だけで扱う。

この経路は設計候補であり、現在そのまま実行できる環境・コマンドはない。既存ワークロードへの評価処理追加は通常のレビューとデプロイを経る。運用者による本番roleの代理取得、フェデレーション信頼設定の変更、長期APIキーの取得は行わない。代表質問・期待結果・合格閾値の確定と実行経路の検証が済むまで、検索品質の受け入れ条件は未達とする。

### 回答コスト記録の二環境対応

共有の回答コスト記録処理に残っていたPostgreSQL直接SQLを、業務契約とD1／PostgreSQLアダプターへ分離した。従来のD1経路では記録エラーをチャット側で捕捉していたため、回答が継続してもコスト記録が欠落し得た。既存の匿名・数値usageのみの保存方針を維持し、終了処理はstartedから終端状態への条件付き更新とした。

実際のD1マイグレーションと隔離PostgreSQL 17上で同じ5契約（開始・数値usage・同時終了と再試行・開始なし終了・重複開始）を実行して成功した。Python HTTPS経路と既存ledger単体試験を含め4ファイル12試験が成功した。これは合成データの試験であり、本番コスト集計やモデル接続の検証ではない。

### 分割アップロード操作のセッション認証

2026-11-14、`middleware/upload-session-auth.ts`に残っていたPostgreSQL直接参照を`UploadSessionRepository`へ分離した。署名付きcookieの検証とBAN判定は共通のまま、未失効セッションと現在のユーザー状態をD1／PostgreSQLのアダプターで読み取る。D1側は正規化済みUTC日時で比較し、BAN期限も共通契約のISO文字列へ変換する。セッション延長や認証結果のキャッシュは行わない。

実マイグレーションを適用したローカルworkerd D1と隔離PostgreSQL 17で、同じ6契約を実行した。繰り返し認証による状態不変、失効・期限切れ・退会・BANの即時反映、期限切れBANの解除扱い、トークンに対応する本人識別を確認した。Better Auth発行cookieとの互換性、署名偽造、誤った鍵、本番テストヘッダー拒否、混在tRPC batchの経路判定を含む関連17試験が成功した。[集約証跡](evidence/d1-upload-session-contract-2026-11-14.json)を参照する。本番cookieやR2への実アップロードの合格証拠ではない。

DB SDK・スキーマ・具体アダプターの直接参照を禁止する既存Lintを、共有ライブラリ、ミドルウェア、shared、tRPCにも適用した。既存PostgreSQL認証アダプターの互換エントリーポイント`lib/auth.ts`とオンプレユーザー管理だけは明示的な例外として残す。

### 認証設定とDBアダプターの完全分離

2026-11-14、共有`lib/auth.ts`にあったPostgreSQLのDrizzle接続型・schema・username検索・アダプター生成を`persistence/postgres/auth.ts`へ移した。共有の認証設定はBetter Authの汎用`DBAdapterInstance`とusername存在確認操作を受け取り、具体的なSQL方言・Drizzle型を参照しない。`withAuth`は選択したバックエンドのモジュールを必要な場合だけ読み込む。PostgreSQL側の呼び出し元と既存試験を新しいアダプターのパスへ更新し、接続・transactionの寿命は維持した。

共有認証ファイルのLint例外を撤去し、静的・動的なDB/schema/Drizzleアダプター参照が拒否されることを確認した。オンプレ専用ユーザー管理の例外は継続する。D1の実ログイン・セッション取得・ログアウト試験は、PostgreSQL接続モジュールを読み込むと必ず失敗する条件で実行し、成功した。関連単体・D1試験14ファイル225件と、隔離PostgreSQLを含む移行・復旧・OAuth・管理者操作・QA等8ファイル132件が成功した。[集約証跡](evidence/d1-auth-core-isolation-2026-11-14.json)を参照する。本番認証や外部OAuthの実ログイン、D1切り替えの受け入れを示すものではない。

### OAuth連携解除の原子性

2026-11-14、D1の`transaction: false`設定下で既存のOAuth連携解除が複数の独立DELETEになっていることを障害注入で再現した。リフレッシュトークン削除で失敗するとアクセストークンだけが削除され、同意情報削除で失敗すると両トークンだけが削除された。ローカルworkerdの2障害試験が修正前に失敗し、不整合を検出した。

D1アダプターへ`OAuthGrantRepository`を追加し、対象の所有者・clientをバッチ内で解決した上で、アクセストークン、回転再送記録を含むリフレッシュトークン、同一アプリへの全resource同意情報を一つのprepared-statement batchで削除する。最後の同意削除はtargetをmaterializeし、選択した行の削除によって同じアプリの別同意を見落とさない。[D1の公式仕様](https://developers.cloudflare.com/d1/worker-api/d1-database/)ではbatchの途中失敗は全体のロールバックとなる。PostgreSQLは既存のnative adapter transactionを維持する。署名・セッション・CSRFの判定は従来の共通Better Auth middlewareが担当する。

両DBで同じHTTP契約を実行し、他アプリ・他人の保護、セッション・origin必須、2段階の部分失敗、再試行、同時解除を確認した。関連5ファイル97試験と、ログ・Python native HTTPSの2ファイル6試験が成功した。SQL例外は共通hookを出る前に原因情報を落とし、Better Auth側の追加server loggerにもSQLや秘密値を渡さない。障害メッセージに含めた合成canaryがHTTP応答とログへ出ないことも確認した。

固定の合成検証用v2 D1では既存認証試験を含む3試験が成功した。新しい原子性試験はlate failureで全件不変、他人による解除の拒否、成功後の同一アプリ全削除と再実行を確認した。テスト用のUUID名前空間だけを操作し、最後にユーザー・client・トークン・同意・障害トリガーの残数0を再照合した。v3の実データや本番には変更していない。[集約証跡](evidence/d1-oauth-grant-atomicity-2026-11-14.json)を参照する。既発行JWTの有効期間や、代表質問による品質評価、本番切り替えの条件は変更しない。

### 代表質問Embeddingの準備ツール（モデル通信は未実行）

2026-11-14、既存のPython query Embedding関数を使い、モデル・profile・次元数・接続先・認証方式を固定manifestと照合する私有入力生成ツールを追加した。既定のpreflightは通信を行わず、`--execute`で明示した場合だけ既存ワークロード認証で生成する。質問ごとに一度だけ生成した同じベクトルを、所有者・動画選択・性能反復を変えたケースでも再利用し、既存のPG/D1検索評価入力へ接続する。モデル設定の自動変更や、新たな認証権限の付与は行わない。

関連Python 3ファイル81試験とAPI 3ファイル13試験が成功した。生成試験のモデル応答は合成stubであり、実OpenRouter接続や品質の証拠には使わない。出力の実TypeScript validator互換性、768次元の既存オンプレ構成、入力・出力の私有権限、途中失敗、競合と上書き拒否、秘密値のログ非出力を確認した。[実行手順](d1-representative-query-preparation.md)と[集約証跡](evidence/d1-query-preparation-tooling-2026-11-14.json)を参照する。配布・実行経路のレビュー、接続済みワークロードの確保、代表質問・正解ラベルと閾値の確定、実モデル評価は残る。

### 既存フェデレーション主体での隔離評価エントリーポイント

2026-11-14、通常のSSM/DB bootstrapを通らない専用`search_evaluation_lambda.handler`を追加した。既定では無効で、専用関数でのhandler選択と明示的な有効化を要求する。既存のモデルとworkload federation設定を照合し、最大16ケースのEmbedding生成だけを行う。既存SQS handlerやroutingは変更しない。質問・生成物は私有の一時領域で扱い、応答とログから質問本文・SDK例外詳細を除外する。

main由来の独立worktreeでも関連5ファイル123試験が成功し、評価コードを先行レビューする[先行レビューPR #1444](https://github.com/videoq-jp/videoq/pull/1444)を作成した。DB、秘密情報bootstrap、queueモジュールのimportを拒否した条件でも、有効化した合成処理が成功した。実モデル応答はstubであり、接続証明には使わない。[実行境界](search-evaluation-runtime.md)と[集約証跡](evidence/d1-evaluation-runtime-preparation-2026-11-14.json)を参照する。

専用関数の作成・数値versionとimage digestの確定・私有invoke client・実接続は未実施である。既存worker用ロールはDB用SSM/SQSの権限も持つため、mainコードレビューとoperator管理の境界を維持する。ローカル運用者による本番roleのassumeや、フェデレーション信頼設定の変更は行っていない。

### オンプレCIの配布物取得失敗

2026-11-14、[CI #43600462435](https://github.com/videoq-jp/videoq/actions/runs/43600462435)はWhisper用zlibの固定SHA-256照合で停止した。Honoを含む他の選択された試験は成功した。CIが受け取った不一致の実体は保存されておらず、根本原因は特定できていない。[公式サイト](https://zlib.net/)の掲載値と、通常URL・fossils URLからの独立取得は現在のpinと一致したため、期待値やバージョンは変更していない。

取得・SHA照合を最大3回まで行い、正しいpinに一致した候補だけを展開用パスへ公開するhelperを追加した。ネットワーク失敗と不正な本文からの再取得、継続不一致の失敗・既存ファイル保護、未検証一時ファイルの削除等7試験と、実公式配布物の取得が成功した。[集約証跡](evidence/d1-onprem-source-download-2026-11-14.json)を参照する。完全なWhisperイメージ再buildとオンプレライフサイクルの合格は、最新headのCIで確認する。

### 私有起動クライアント（実起動は未実施）

2026-11-14、評価専用Lambdaの数値version・image digest・role・モデル構成を照合する起動クライアントを追加した。私有manifestから質問を初出順に重複排除し、16件ずつ同期invokeする。応答のExecutedVersion、入力ハッシュ、case ID、検索範囲、ベクトルを検証し、全件成功時だけ元の全ケース・sample数を持つ私有ファイルへまとめる。SDKの暗黙的なrole/web identity/processによる資格情報取得経路を除去し、固定endpoint・1試行で実行する。

関連5ファイル128試験（新client 29試験）が成功した。transportは合成mockであり、実AWS・モデル呼び出しは行っていない。[実行手順](d1-remote-query-preparation.md)と[集約証跡](evidence/d1-remote-evaluation-client-2026-11-14.json)を参照する。PR #1444の承認待ちは維持し、そのレビュー対象のheadや既存本番関数を変更していない。専用関数の作成・実接続・検索品質評価・D1切り替えは引き続き未実施である。

### native HTTPS試験のTLS最低バージョン

2026-11-14、CodeQLの`py/insecure-protocol`指摘 #75は、本番APIではなくnative試験のPython接続確認に対するものだった。試験用SSLContextへ`minimum_version=TLSv1_2`を明示し、同じcontextでCAを確認して接続する。実接続でTLS 1.2または1.3が選択されたことも検査する。証明書・hostnameの検証は維持し、alert抑制や検証無効化は行っていない。変更後のPython署名付きHTTPS→workerd Hono→D1試験は成功した。CodeQL上の解消は、新しいheadの解析結果で確認する。
