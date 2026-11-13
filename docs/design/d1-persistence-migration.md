# D1移行: 永続化依存の棚卸しと最初の契約

作成日: 2026-11-13。移行計画 v1.0 に対する棚卸しと段階的な実装記録。
本番DBは既存PostgreSQLのまま。Phase 0 の実測、本番移行、D1対応は未完了。

## 現状と移行単位

| 対象 | 現在の依存 | 抽象化すべき業務操作・保証 |
| --- | --- | --- |
| `db/pool.ts`、`types/bindings.ts`、`runtime/node.ts` | pg Client/Pool、NodePgDatabase、Hyperdrive | 接続の生成・終了をアダプター内に限定。共有契約にBindingsを渡さない |
| `db/schema/{modern,better-auth,lms}.ts` | pg-core、vector、jsonb、配列、日時 | PostgreSQL履歴は保存し、SQLite履歴を別途作成 |
| `user-repository`、`account-integrations-repository` | ユーザー設定、暗号化済み秘密情報 | 存在しないユーザーと未設定を区別。秘密情報を読み返さない |
| `video-repository`、`multipart-upload-repository`、`media-repository`、`video-evidence-repository` | 動画CRUD、容量予約、所有権、行ロック | 所有者付き更新、予約と確定・解放、削除後の不可視化 |
| `quota-repository`、`billing-repository`、`admin-repository` | UTC月境界、集計、課金と利用枠更新 | 条件付き消費、返還の冪等性、管理者上書き保持 |
| `external-task-repository`、`maintenance-schedule-repository`、`mcp-idempotency-repository` | ジョブclaim、ロック、重複排除 | claim世代/lease、期限切れ回収、完了の一回性 |
| `course-repository`、`membership-repository`、`course-invitation-repository`、`course-authority`、`tag-repository` | 参加枠、招待、所有者、複数行ロック | 参加枠と招待消費の原子性、権限変更との競合 |
| `lms-{installation,resource}-repository` | LMS所有権確認とリソース更新のトランザクション | 所有者の無効化・連携停止と競合する操作の拒否 |
| `chat-repository`、`conversation-repository` | 会話lease、ログ、PostgresSaver、専用schema `chat_memory` | 会話スコープ、checkpoint確定、並列生成拒否、削除・期限切れ |
| `vector-repository`、`lib/embedding-schema.ts` | PGEngine/PGVectorStore、pg Pool、次元別テーブル | 次元整合、検索対象制限、結果の所有権再検証、接続終了 |
| `lib/auth.ts`、`middleware/{auth,upload-session-auth}.ts` | Better Auth Drizzleアダプター、直接DB参照 | 認証スキーマとセッション・APIキー・無効ユーザー判定 |
| `features/lti/*`、`features/lms/*`、`features/admin/onprem-users.ts` | 直接SQL、FOR UPDATE/SHARE、SKIP LOCKED、advisory lock | LTI鍵生成、同期claim、プライバシー削除、セッションと教材権限の同時検証 |
| `features/qa/core.ts`、`features/chat/{conversation,message}-service.ts` | withClient、DB具体型 | 認可付き検索範囲取得、会話履歴・ログ確定をRepositoryへ移す |
| `runtime/postgres-rate-limit.ts`、`features/health/routes.ts`、`app.ts` | DBベース制限、疎通・起動処理 | オンプレ用制限とクラウド用制限の構成、バックエンド別readiness |
| Python `db.py`、`video_sql.py`、`job_execution.py`、各種checkpoint | psycopg、直接SQL、処理lease、途中再開状態 | 内部APIでclaim・heartbeat・完了・失敗・途中保存を表現 |
| Python `advisory_locks.py`、`pipeline/*`、`tasks/*` | ベクトル書込ロック、シーン・画像・字幕更新、退会削除 | シーン保存とOutbox発行、世代付き再索引、削除後の再生成防止 |

上記は機能ごとの静的棚卸しであり、SQL全件の意味解析や実データ計測ではない。

## 計画へ追加すべき項目

- **LangGraph checkpointの移植**: Vectorizeに移す対象とは別の永続化。
  `PostgresSaver`をクラウド版から排除する保存方式と、checkpoint・回答ログ・lease確定の整合性を設計する。
  `chat_memory` は通常のアプリスキーマ外なので、移行対象件数とデータ取得にも含める。
- **LTIのロック依存**: 鍵生成や同期ジョブだけでなく、履歴・会話・教材権限にもロックがある。
  UnitOfWorkでSQLハンドルを共有せず、認可の再確認を含む業務操作を契約にする。
- **途中再開データ**: 字幕・視覚処理checkpointとジョブleaseも移行対象。
  キュー内の既存メッセージとDB切替の境界をリハーサルする。
- **旧世代インデックス処理**: 削除や再索引後の遅延配送による復活を防ぐ世代番号と条件付き確定を検討する。

## 契約テスト基盤

最初の小さな業務単位は `UserSecretsRepository`。
`getSearchApiKeyStatus` は未存在をnull、未設定をfalse、設定済みをtrueで返す。
`setSearchApiKey` は未存在をfalseとし、更新対象ユーザー以外を変更しない。
暗号化は呼び出し側の責務。空文字とnullは未設定で、削除の再実行も成功扱いとする。

- 共通契約: `apps/api/src/persistence/contracts/user-secrets.ts`
- 移行中PostgreSQLアダプター: `apps/api/src/persistence/postgres/user-secrets.ts`
- 共通テスト: `apps/api/test/persistence/contracts/user-secrets.contract.ts`
- 実DB実行: `apps/api/test/persistence/user-secrets.postgres.integration.test.ts`

PostgreSQLアダプターは既存関数へ委譲する。既存呼び出し元はまだ変更しない。
テストは各ケース専用schemaと実テーブルを作成し、終了時に削除する。
操作に必要な最小テーブルを使用するため、完全なスキーマ移行テストの代替にはならない。

```sh
PERSISTENCE_TEST_DATABASE_URL=postgresql://localhost/videoq_test \
  npm run test:unit --workspace @videoq/api -- test/persistence
```

専用テストDBとschema作成権限が必要。未指定ならスキップし、アプリのDATABASE_URLを使用しない。
D1追加時は同じ共通テストへ実DB fixtureを渡す。インメモリ代替だけで合格としない。
初期の棚卸し時点ではD1 fixture、両バックエンドCI、他Repositoryの契約は未実装だった。後続の実装状態は末尾の進捗を参照。

## 次の作業

1. Phase 0で容量・件数・レイテンシ・費用を計測し、受け入れ値を決める。
2. ユーザー・動画のドメイン型と業務操作を抽出し、呼び出し元を順次移す。
3. 利用枠、ジョブ、LTI、会話の原子性・競合契約を固定する。
4. 方言別スキーマ・接続・設定検証、D1実装、実D1契約テストへ進む。

認証情報や暗号化済み秘密情報を棚卸し・計測ログに出力しない。
本番リソース作成・データ抽出・書込停止・切替はこの変更では実施しない。

## 実装進捗（2026-11-13 追記）

最初の棚卸しから、次の実装へ進めている。**移行完了・本番投入可能という意味ではない。**

| 項目 | 現在の状態 |
| --- | --- |
| 独立したSQLiteスキーマ | アプリ・Better Auth・LMSの55テーブルと、新しい正本シーンテーブルを追加。pgvectorの2テーブルはD1へ作成しない |
| Drizzle履歴 | `drizzle.d1.config.ts` / `drizzle-d1` を追加。既存PostgreSQL履歴は変更しない |
| 接続 | `db/d1/connection.ts`。D1 bindingからDrizzle SQLite接続を生成 |
| 設定 | 明示的な `cloud` はD1、`onprem` / Node既定はPostgreSQL。クラウドPostgreSQLは `PERSISTENCE_BACKEND=postgres` と `MIGRATION_ALLOW_CLOUD_POSTGRES=true` が両方必要 |
| 開発環境の互換性 | edition未指定は移行期間の既存PostgreSQL設定を維持。既存wrangler設定と本番リソースは未変更 |
| ユーザー情報 | `UserRepository`へ分離。account.meの集計・利用枠の単位変換・UTC月境界とSearch APIキー設定を両DBで実装 |
| 認証 | HTTP認証経路とmiddlewareを`withAuth`経由へ変更。D1はSQLite Drizzle、PostgreSQLは既存アダプター。共通設定・ポリシーを維持 |
| RAG検索 | `@langchain/cloudflare`の`CloudflareVectorizeStore`を使用。pgvector実装はPostgreSQLアダプターへ移動 |
| 検索の認可 | Vectorize結果の `scene_id` / `revision` を使ってD1から本文を再取得。所有者、対象動画、処理完了、ユーザー可視性、次元、revisionを検証 |
| 検索範囲 | 2048バイト未満になるよう動画IDフィルタを分割。各検索結果をcosineスコア降順で統合 |
| ジョブ台帳 | `JobRepository`のclaim・heartbeat・complete・failを両DBで実装。単一条件付きupsert/updateにより重複claimと古いleaseの書込を拒否。Workerからの呼出しは未接続 |
| readiness | 選択されたバックエンドへpingする |
| 未移植操作 | D1設定時に既存`withClient`からPostgreSQLへ接続することを拒否。部分移行中の二重正本化を防ぐ |

### D1データ規約

- UUIDはTEXT、JSONは標準JSONのTEXT、Booleanは0/1、日時はUTC ISO 8601（ミリ秒）を使用する。
- Better Auth Dateフィールドは専用Drizzle customTypeでDateへ復元する。
- Better Authの配列・JSONフィールドはアダプターがシリアライズするため、SQLite schemaでは通常のTEXTとする。DrizzleのJSONモードを重ねない。
- シーンIDは64バイト以内。本文・時刻・動画情報の正本はD1。Vectorizeには `scene_id`, `revision`, `user_id`, `video_id` を同期する設計。
- Vectorize bindingは `SCENE_VECTORIZE_1536` と `SCENE_VECTORIZE_768`。既存Embedding生成は共通処理を使用し、モデル変更はしない。
- `CloudflareD1MessageHistory`はLangGraphのcheckpoint saverと同じ契約ではないため、会話checkpointを単純置換しない。

### この時点の検証

- `npm run test:persistence --workspace @videoq/api`: 実PostgreSQL URL指定で26件成功。
- D1テストはMiniflare/workerdで独立した全マイグレーションを実行。外部Vectorize呼出しのみテストダブルで検証。
- 共通契約で、12配送の同時claimの勝者が1つになること、期限切れ回収、古いleaseの拒否、完了重複配送、ジョブID衝突を確認。
- D1の実ログイン・ログアウト、APIキーと停止アカウント、OAuth配列・JSON・Date・Boolean、UTC利用月集計を確認。
- テーブル名・カラム名・外部キーの参照先と削除/更新動作の方言間比較を追加。
- API全体の通常テストは1,364件成功（外部DB等を要する866件はスキップ）、Workersテストは58件成功。この実行後に追加したD1ユーザー情報テストも個別スイートで成功。
- 既存PostgreSQL Better Auth移行テストも専用の実PostgreSQLで成功。
- API型チェック・lint、既存62件のマイグレーション履歴検証、D1 Drizzle checkが成功。
- リモートD1、実Vectorize、検索Recall、本番データ照合、性能・料金評価はまだ実施していない。

### 次に必要な実装・リリース条件

1. 動画・コース・タグ・利用枠・課金・LTI/LMS等の全業務操作をD1アダプターへ移す。現在のfail-closedは未移植を検出するためのもので、全機能のD1対応を意味しない。
2. Better AuthはD1の対話的transactionが使えないため `transaction: false`。特に複数行のOAuth grant削除など、アプリが要求する原子性をD1 batchの業務操作へ移し、競合・部分失敗の試験を完了する。本番切替の前提条件とする。
3. 後述の索引保存・同期アダプターをPython Workerの内部APIへ接続し、実Vectorizeのメタデータ索引作成と統合検証を完了する。
4. Python Workerの永続化を署名付き内部APIへ移す。ジョブ台帳の契約だけでは動画処理パイプライン全体のD1移行にはならない。
5. LangGraph checkpointの保存方式と会話lease・回答ログの確定をD1へ移す。
6. Phase 0の計測、再実行可能なデータ移送、リハーサル、両環境E2E、実D1/Vectorize検証、CI、切替・復旧演習を完了する。
7. 全機能移植後に、クラウドの未指定editionの扱いを含む起動時設定検証とwrangler bindingsを確定し、検証済みのD1へ切り替える。

参照: [LangChain Cloudflare](https://reference.langchain.com/javascript/langchain-cloudflare)、
[D1 batchの原子性](https://developers.cloudflare.com/d1/worker-api/d1-database/)、
[Vectorizeフィルタ](https://developers.cloudflare.com/vectorize/reference/metadata-filtering/)、
[Better Auth Drizzle](https://better-auth.com/docs/adapters/drizzle)。

## 続行実装: 動画登録・配送・参照系

この段階では次を追加した。動画更新・削除と索引同期は後述の追加実装で対応した。multipart制御、AI/処理利用枠、コース/LTIの全操作、Worker永続化、会話checkpointと実データ移行は引き続き未完了。

| 業務操作 | D1での実装と保証 |
| --- | --- |
| アップロード登録 | 容量・UTC月間利用枠・動画・冪等性記録を単一batchで確定。並行時も上限超過を拒否し、同じキーの再試行は一回だけ加算 |
| YouTube登録 | 動画、冪等性記録、文字起こしジョブOutboxを同じbatchへ保存 |
| アップロード確定 | 所有者・保存先・uploading状態を再確認し、pending遷移とOutboxを一緒に確定 |
| 動画参照 | 詳細、メタデータ、ページ一覧、状態別件数、放置アップロード一覧をD1対応。タグ・視覚処理の進捗も共通DTOへ正規化 |
| 配送Outbox | claim、完了、失敗バックオフ、dead-letter、監視、履歴削除をD1対応。期限切れleaseの古いattemptは更新できない |
| 容量返却 | 外部ストレージ削除後の容量返却と配送タスク完了を同じbatchで確定し、記録済みの効果は再適用しない |
| 起床期限 | Outboxのlease/待機期限、アップロードheartbeat、招待の配送枯渇、対象LMSの同期期限をD1 SQLで集計 |
| メディア・字幕証拠 | 所有者・講座参加・共有リンクの権限を再確認。LMS管理教材をnative共有へ公開しない。字幕証拠は許可スコープ内のcompleted動画に限定 |
| タグ | 一覧・詳細・作成・更新・削除を両DBへ分離。所有権確認とエラーの優先順位、動画リンクのcascadeを維持 |
| CI | 既存Honoテストに専用PostgreSQL URLを渡し、共通契約も毎回実行する設定を追加。D1 Drizzle checkも追加 |

### バッチ内部のガード

SQLiteでは対話的なSELECT後に任意のコールバックをトランザクション実行する構造を使わない。

- 動画登録では、直前のINSERT成功を同じbatch内の `changes()` / `last_insert_rowid()` で引き継ぎ、既存の冪等性記録を予約確定の条件に使う。非冪等リクエストの内部記録はコミット前に削除する。
- 容量返却では、leaseと過去の効果記録を `mutation_receipts` に一時保存し、そのランダムトークンで後続の更新を条件付ける。ガードの作成から削除までが一つのbatchなので、正常終了時にもSQLエラー時にもガードは残らない。
- これらはD1アダプター内部の実装であり、共有サービスへSQL・D1・疑似transactionハンドルを公開しない。
- SQLite専用の `mutation_receipts` により、この時点のD1スキーマは57テーブルになった。PostgreSQL履歴は変更しない。

### 参照性能の残課題

SQLiteの組み込みLIKE/NOCASEはUnicodeの大文字小文字を十分に扱えないため、キーワード検索は200行ずつの限定ページを読み、JavaScriptで文字列照合する。`%` / `_` は通常の部分文字列として扱う。Unicode検索用の正規化索引・FTS導入は、意味を維持してから最適化する。

メタデータ応答は字幕本文を含めないが、UTF-16単位の文字数を正確に返すため、D1アダプター内部では現時点で本文を読む。PostgreSQLのSQL内集計より転送量が増えるため、今後の字幕書込契約にUTF-16長の保守を含めることを検討し、性能比較で検証する。

### 追加した検証

- 動画登録の共通契約10件を両DBで実行。並行上限、冪等性、月替わり、他所有者の拒否、SQL失敗時のrollbackを確認。
- 配送Outboxの共通契約8件を両DBで実行。古いlease、効果の二重適用、完了失敗時のrollback、再試行上限と履歴保護を確認。
- タグの共通契約3件を両DBで実行。
- サービス経由でD1へのアップロード登録・確定・YouTube登録・SQS配送・配送失敗からの回復を確認。R2/SQS通信はテストダブル、DBはworkerd D1。
- D1のメディア共有/LMS隔離、UTF-16位置、タグ/視覚処理の表示、回復期限を追加検証。
- D1テストは全マイグレーションを25文単位のbatchで適用するようにし、プロセス間通信による起動負荷を削減した。

### 最新の回帰検証結果

専用のローカルpgvector PostgreSQLとworkerd D1を使用し、`QUOTA_TEST_DATABASE_URL`、`PERSISTENCE_TEST_DATABASE_URL`、`EMBEDDING_TEST_DATABASE_URL`、`LMS_TEST_DATABASE_URL` を指定してAPI全体を実行した。

- API: **2,189件成功、93件スキップ**。ブラウザー/ライブサービス等の未指定条件でスキップされた試験を、本番移行の証明には含めない。
- Workers: **58件成功**。
- オンプレミスNodeビルド、API型チェック・lint、D1 Drizzle check、既存PostgreSQLの62件のマイグレーション履歴検証が成功。
- D1の再生成は「No schema changes」で、追加マイグレーションの取りこぼしは検出されなかった。
- PostgreSQL上でクラウド専用の機能ポリシーを調べる既存テストは、移行中の明示的PostgreSQL許可を設定するよう変更した。アプリケーションの暗黙フォールバックは追加していない。

これはローカルの回帰検証であり、リモートD1/Vectorize、実データ照合、切替後の性能・検索品質、未移植の全業務操作の完了を意味しない。


## 続行実装: 動画変更・削除と索引同期

### 原子的な動画変更

動画更新・削除を業務契約として分離し、PostgreSQLとD1へ実装した。字幕変更では動画のソースrevision更新、旧シーンの不可視化、Vectorize削除タスク、再索引配送を同じD1 batchで確定する。メタデータだけの変更では索引を無効化しない。削除では状態の条件付き再確認、アップロード中の利用枠返却、R2削除Outbox、索引削除タスクを確定する。外部サービスの通知失敗はコミット済みDB操作を取り消さない。

### 段階的な索引公開

- ソースrevisionと次元別headで競合を検出し、20シーン以下の分割書込み後に期待件数を確認して公開する。古いrunの再試行は新しいheadを上書きしない。
- run内の同一シーンは不変とし、同じ内容の再試行だけを許す。ベクトルIDはrunと内容から生成し、古い削除が新しい索引を消さないようにする。
- 768/1536次元の同じシーンIDを共存可能にした。同期タスクIDも次元を含める。
- 検索時はVectorizeが返した実IDとD1の現在のvector ID・revision・所有者を照合する。本文の正本はD1とする。
- 同期タスクは期限付きlease、再試行、古いattemptの拒否、遅延upsertの補償削除を実装した。完了後はEmbedding payloadを消去する。
- 完了upsertの定期照合では伝播待ち時間を設け、欠損時は既存の再索引配送へ修復ジョブを追加する。古いupsertは削除タスクへ変換する。
- スケジュール保守処理と起床期限へ接続した。ただしPython Workerからのシーン書込み入口は未接続であり、実パイプラインのD1対応完了とはしない。

追加テーブルによりD1は62テーブル。独立した0002〜0004マイグレーションを追加し、PostgreSQL履歴は変更していない。

### LangChainとVectorize V2

`@langchain/cloudflare` のCloudflareVectorizeStoreを検索・書込み・削除に使用する。同パッケージの旧Vectorize型と実V2 bindingの差はD1アダプター内へ閉じ込めた。queryのmetadata指定をV2形式へ変換し、不要なベクトル値を取得しない。V2の非同期mutation受付後もD1照合で欠損を検出できるようにした。Vectorizeのmetadataだけで認可しない。

参照: [Vectorize client API](https://developers.cloudflare.com/vectorize/reference/client-api/)、[D1 limits](https://developers.cloudflare.com/d1/platform/limits/)。

### 最新の検証

- API全体: **2,221件成功、93件スキップ**。Workers: **58件成功**。
- 動画変更の共通契約をPostgreSQLとworkerd D1で実行。索引の段階公開、並行変更、SQL失敗時rollback、lease失効、遅延provider応答、欠損修復、次元分離を検証した。
- サービス経由の字幕検証・更新・削除もworkerd D1で検証した。Vectorize/R2/SQSはテストダブルであり、実サービスの検証を代替しない。
- API型チェック・lint成功。実データ移行・本番切替は実施していない。

## 続行実装: Python Workerの署名付きジョブ台帳API

`/internal/worker/jobs/{claim,heartbeat,complete,fail}` をHonoへ追加した。
共通JobRepositoryを経由するためD1/PostgreSQLを同じ操作で扱う。
署名はHMAC-SHA256で、version・timestamp・method・origin・path・実際のbody bytesを含む。
有効期間60秒、未来時刻の許容5秒、本文8KiB上限、32バイト以上の専用秘密値を要求する。
署名だけでは重複配送を排除しない。job identityとlease tokenで再実行・古いattemptを制御する。
任意の例外本文を受け取らず、失敗は固定コードだけを記録する。

Pythonのジョブ台帳はcloud/D1選択時に内部APIを使用する。HTTPS originだけを許可し、
リダイレクトを拒否し、timeoutと応答サイズを制限する。API障害時のDBフォールバックはない。
オンプレミスの既存PostgreSQL実装は維持し、クラウドPostgreSQLの移行継続は明示フラグを要求する。
SSM APP_PARAM_NAMEから専用秘密値を読めるようにし、D1選択時はDB用SSM parameterを取得しない。
旧DB helperもD1選択時は拒否するため、残存した直接SQLを誤ってNeonへ書き込まない。

検証: workerd D1に対する署名API3件、Pythonの経路選択・署名・設定・秘密値bootstrapを追加。
Python全体は549件成功、114件スキップ（追加bootstrap試験前）。
期限切れ・本文/宛先/操作改変・未署名・無効lease・過大payloadを拒否することを確認した。

未完了: 動画取得・状態遷移・字幕/シーン保存・索引writerへの内部API接続と各pipeline呼出しの移植。
ジョブ台帳の接続だけで動画処理全体をD1化したとは扱わず、本番設定は切り替えない。

## 続行実装: 字幕編集後の再索引をD1へ接続

署名APIへ `/internal/worker/scene-index/{source,start,stage,publish}` を追加した。
sourceは信頼されたWorker専用の動画ID検索で、所有者の再確認後に現在の字幕とrevisionを取得する。
start/stage/publishは既存のD1業務アダプターへ委譲し、所有者・revision・次元別head・期待件数で確定を制御する。
シーン本文とEmbeddingは最大20件、1MB以下のリクエストに制限し、署名はジョブAPIと同様に操作・宛先・本文へ結び付ける。
索引mutation前に保守alarmを予約するため、応答の消失でも永続化済み同期タスクを回復できる。

Pythonの `reindex_video_transcript` はD1選択時、このAPIを使用して再索引する。
従来と同じSRT解析・Otsu分割・Embedding生成を使い、D1/Vectorize経路ではpgvectorのstorage検証とPostgreSQL advisory lockを呼び出さない。
20件ずつEmbeddingを生成・stageし、すべて成功後に公開する。削除済み動画はスキップし、途中の字幕変更は再試行対象とする。
空字幕は期待件数0のrunを公開して当該profileの索引を除去する。
オンプレミスでは既存PostgreSQL経路を継続する。

検証: 署名APIとworkerd D1 writerの13件成功、Pythonの新規経路・既存再索引・署名clientの13件成功。
シーンの分割配送、空字幕、欠損動画、途中競合、所有者拒否、公開前の不可視性と同期タスク作成を確認した。
Vectorize provider通信の実試験、初回indexingからcompletedへの遷移、文字起こし保存と各pipelineの移植は引き続き未完了。

上記接続後のPython Worker全体: **555件成功、114件スキップ**。
API型チェック・lint・オンプレミスNodeビルドも成功した。

## 続行実装: 初回索引の完了遷移

`index_video_transcript` もD1選択時は署名APIと共有のシーン分割・Embedding生成を使用する。
`scene-index/finish` は動画所有者・file key・source revision・次元別の公開済みheadを確認し、
現在のシーンに対応するupsertタスクがすべて完了した場合だけ `indexing → completed` を条件付き更新する。
公開済みだが配送待ちの場合はpendingを返し、Lambda/SQSの再試行時にEmbeddingを再生成しない。
動画削除・状態変更・字幕revision変更・file変更では古い処理からの完了を拒否する。
空字幕の初回索引は従来と同様、明示的なallow_empty指定を必要とする。

ここで配送完了とはVectorize V2 mutationの受付と既存同期処理の成功を指す。
Vectorizeの検索への伝播は非同期なので、即時の検索可能性の保証には使わない。
伝播後の欠損検出は既存の定期照合・修復を使用する。実サービスでの遅延・検索品質検証は未完了。

署名API試験5件とPythonの関連29件が成功。配送待ちのstatus維持、
異なる次元/古いrevision/fileの拒否、完了の再試行、Embedding再生成の回避、
空字幕の拒否と既存PostgreSQL経路への影響を確認した。
初回文字起こしの字幕保存・処理利用枠・分割文字起こしcheckpointは引き続き移植対象。

この変更後のWorker全体は559件成功、114件スキップ。
API型チェック・lint・オンプレミスNodeビルドも成功。

## 続行実装: 処理時間の利用枠予約

`ProcessingQuotaRepository.reserve(videoId, seconds)` をD1/PostgreSQLへ実装した。
動画に記録済みの予約は再加算せず、別動画の並行予約はユーザーの残り枠を条件として確定する。
UTC月替わりでは処理時間とAI回答数を一緒にリセットする。月が替わっても既存動画の予約は再加算しない。
全体の利用停止、無制限枠、JavaScriptの整数精度上限、PostgreSQLの動画処理秒数integer上限を考慮する。
D1は一時receiptを使った単一batch、PostgreSQLは動画行ロックと条件付きユーザー更新で実装し、
動画の書込失敗時はユーザー使用量もrollbackする。

署名API `/internal/worker/processing/reserve` とPythonの業務クライアントを追加した。
通常文字起こしの予約callbackはD1選択時にこのAPIを使用し、オンプレミスは既存SQLを維持する。
これは利用枠操作の移植であり、文字起こし開始時の動画取得・状態遷移・字幕保存や、
分割文字起こしのcheckpoint処理のD1移植はまだ完了していない。

検証: 同じ契約6件をworkerd D1と実PostgreSQLで実行し、双方成功。
署名APIでの再送時の一回加算と不正入力拒否も検証した。
Pythonの既存PostgreSQL文字起こし保存・再開と新クライアントは32件成功。

## 続行実装: 文字起こしの状態遷移・字幕保存

`WorkerTranscriptionRepository` とD1アダプター、署名API
`/internal/worker/transcription/{source,begin,finish}` を追加した。
sourceは字幕本文を転送せず、動画情報とsource revisionを返す。
YouTubeの場合だけ暗号化済みSearchAPI鍵を返し、Python側で既存の復号処理を使用する。
本文・認証情報・providerの例外をログや失敗レコードへ追加しない。

beginは動画所有者・file・revision・開始状態を条件としてprocessingへ遷移する。
finishは同じ所有者/fileでprocessing中の動画だけを確定する。
元のrevisionが一致すれば生成字幕を保存してrevisionを更新し、旧索引の無効化と
初回索引Outboxの登録を同じbatchで行う。字幕が編集されていた場合はその内容を保持してcompletedとし、
手動編集が登録した再索引ジョブへ任せる。失敗は固定コードだけを記録する。
並行finishや応答消失後の再試行でも字幕の再上書き・索引Outboxの重複登録をしない。

Pythonの `transcribe_video` はD1選択時に新しい業務API経路を使用する。
YouTubeと軽量動作の文字起こし・利用枠予約・保存・索引配送の接続を追加した。
保存後のSQS配送はHono側の永続Outboxが担当し、Workerが直接配送を完了できることを保存成功の条件にしない。
オンプレミスの既存PostgreSQL処理は維持する。

実動画アップロードのheavy pipelineは、長時間動画を一つのLambdaで代替せず、
既存の分割文字起こし/checkpointのD1移植が済むまで未対応として明示的に失敗する。
本番設定は切り替えていない。この制限の解消は移行完了の必須条件である。

検証: workerd D1と署名APIの12件、Python関連10件が成功。
競合時の編集・空字幕保持、所有者/file/削除の拒否、Outbox失敗時の字幕・revision rollback、
安全な失敗コードと再試行、PostgreSQLに接続しないクラウド入口を確認した。

この変更後のWorker全体: 565件成功、114件スキップ。
別途実PostgreSQLを指定した既存文字起こし保存・再開試験31件も成功。
API型チェック・lint・オンプレミスNodeビルドが成功した。

## 続行実装: 分割文字起こしのD1 checkpoint

分割計画のload/initialize、4 laneのpending head、チャンク状態取得・保存・失敗記録、
音声なしの終端処理、結果のページ取得・最終確定をD1アダプターと署名APIへ移した。
計画初期化と処理利用枠は同一batchで予約し、並行した初期化は同じ未完了runを再利用する。
最大10,000チャンクを計画でき、チャンク行作成の失敗時は利用枠とrunもrollbackする。

チャンク更新は現在のfile/source revision/runを再確認する条件付きSQLで行う。
完了済みの結果は上書きせず、遅れて届いた失敗で完了チャンクの状態を悪化させない。
失敗本文は固定コードへ置き換える。音声なしの場合はrunと動画を同じbatchで終端化し、queued laneを無効にする。

最終化では最大20チャンク・約1MiBまでのページを読み、順序と全件の存在をPython側で確認してSRTを生成する。
DBでも全チャンク完了を再検証し、字幕保存・revision更新・run完了・索引Outboxを同一batchで確定する。
途中のproviderやSQS障害後は保存済み結果を再利用でき、完了応答消失後の再送でも索引ジョブを重複登録しない。
空の文字起こしはエラーとしてrunを完了し、無限に同じ空結果を再開しない。

Pythonの既存分割タスクへD1クライアントを接続し、実動画アップロードの開始を止めていた暫定ガードを撤去した。
FFmpeg/Whisper処理・4 laneの配送・SRT生成は共有実装を継続する。PostgreSQL版のcheckpoint実装も維持する。
ただし字幕最終化後の視覚解析 `segmented_visuals` はPostgreSQL依存が残るため、
VIDEO_VISUAL_ENABLEDが有効な通常構成全体のD1移行はまだ完了していない。視覚処理を省略した完了とは扱わない。

検証: D1保存・署名APIの21件、Pythonのcloud checkpoint/文字起こしclient関連14件が成功。
計画の一回予約、lane順序、最初の保存結果の保持、古いソース拒否、quota拒否、SQL失敗時rollback、
音声なしの停止、全件が揃う前の確定拒否、run/字幕/Outboxの原子性を確認した。

D1の `video_transcription_runs.transcript_hash` はPostgreSQLのMD5ではなくsource revisionを格納する。
既存checkpointを移送する場合、この値と `video_index_versions` の対応を変換・照合する必要がある。
単純なテーブルコピーだけで既存runを再開可能とは扱わない。

### この段階の回帰検証

- Python Worker全体: 569件成功、114件スキップ。
- 実PostgreSQLで分割文字起こし・字幕保存・再開とcloud clientを検証: 58件成功。
- API全体（quota/persistence/embedding/LMSのPostgreSQL URLを指定）: 2,254件成功、93件スキップ。
- API型チェック・lint・オンプレミスNodeビルド成功。

無制限の並行実行では複数の既存DB試験がタイムアウトしたため、その実行を停止した。
他の重い検証と並走させず、`test:unit -- --maxWorkers=2` で再実行し、上記API全体の成功を確認した。
テストの時間制限やアプリの処理を緩める変更は行っていない。

Workers試験58件も成功。CIのAPI試験を同じ `--maxWorkers=2` とWorkers試験の別実行へ変更し、
workflow関連の既存Node試験377件が成功した。

## 続行実装: 視覚解析のD1 checkpointと不変オブジェクト参照

`VisualCheckpoints` を追加し、計画の初期化・取得、未処理一覧、チャンク保存、失敗記録、ready遷移をD1と署名APIへ接続した。
並行した初期化は同じrunを再利用する。現在の動画file/source/runが一致する操作だけを許可し、
全チャンクが保存済みで一つ以上のフレームがある場合だけreadyにする。
保存済みチャンクを後続配送で上書きせず、遅い失敗通知でreadyや保存結果を壊さない。
D1専用0005マイグレーションで `video_visual_chunks.object_version` を追加した。テーブル数は62のまま。
PostgreSQLスキーマ・履歴は変更していない。

### R2公開と読み出し

PostgreSQL版の「行ロック中にPUT」をD1へ持ち込まない。
チャンクは `${file}.visual-v2/${run}/${index}/${attempt}.bin|json` に保存し、DBの条件付き更新が最初に採用したattemptを正本とする。
負けた配送や削除後の結果は、そのattemptだけのオブジェクトを補償削除する。
PUT途中の通常の例外でも未公開のattemptを削除する。

最終manifest/overviewはrun別のprefixに保存し、その後にDBをreadyへ遷移する。
manifestは選択済みのchunk_versionsを持ち、APIはDBのready runとmanifest内のrun ID・版の件数を照合する。
D1の証拠DTOはreadyのvisualRunIdを返し、準備前やmanifest欠損時に旧共通キーへ戻らない。
PostgreSQLの既存共通キーとmanifest読み出しは維持する。
全世代の画像は既存のvisual prefix削除対象に含まれる。

Pythonは共有のFFmpeg処理・manifest/overview生成を使い、D1では署名APIへ、オンプレミスでは既存PostgreSQLへ保存する。
字幕最終化後の視覚処理もこのD1経路を使えるようになった。

### 制限と残作業

- プロセスの強制終了や、PUT/補償削除の両方にまたがる障害で残る孤立R2オブジェクトの定期照合・永続cleanup登録は未完了。
  DBが参照しないattemptは公開しないが、ストレージ回収の保証を完了したとは扱わない。
- 移送する旧ready visual runにはobject_versionがないため、画像・manifestの変換または再生成が必要。
- 実R2/Whisperを含む両環境E2E、実D1/Vectorize、データ移行・性能・検索品質検証は未完了。

検証: D1 visual checkpoint6件、署名API・既存focus/視覚処理を含む関連API58件、
新manifest/証拠読み出しと既存focusの28件が成功。
実PostgreSQLの分割視覚/文字起こし・cloud client35件、Python全体573件が成功（cleanup例外試験追加前）。
追加したcleanup例外試験を含むcloud visuals5件も成功。
API型チェック・lint・Nodeビルド・D1 Drizzle checkが成功。

API全体の回帰試験は2,264件成功・93件スキップで、D1専用列を想定していなかったschema parity試験1件が失敗した。
照合の対象を緩めず、業務列に加えて `video_visual_chunks.object_version` だけを明示的なD1内部列として検証するよう更新した。
この列のためにPostgreSQLへ不要なスキーマ変更を加えていない。

修正後のschema parity試験1件とWorkers58件も成功。
全体試験の成功2,264件と合わせ、今回変更の残る失敗はない。

## 続行実装: 画像PUTの永続台帳と回収

D1専用の `visual_object_attempts` を追加した（0006、D1合計63テーブル）。
動画/runへの外部キーを持たず、動画削除後も回収に必要なfile/run/版の識別情報を保持する。
WorkerはPUT前に署名APIでattemptを登録し、登録が拒否された場合はPUTを開始しない。
チャンク採用・manifest公開は有効なpending attemptだけを許可し、DBの参照確定とattemptのpublished状態を同じbatchで更新する。

未公開のまま期限が切れたattemptと、参照を失ったpublished版をスケジュール保守で回収する。
回収claimはdeleting状態とlease tokenを確定してからR2へ削除を送るため、その版は後から採用されない。
部分削除失敗は固定コードで記録し、5分後に再試行する。期限切れの古いleaseは完了を記録できない。
D1の次回起床期限にも接続し、現在参照中の版については不要な回収アラームを継続しない。

### manifestも書き込みごとの不変版にする

manifestをrun共通キーで再利用すると、古い回収処理が遅れてDELETEした場合に、新しい公開内容を消す余地がある。
このため0007で `video_visual_runs.publication_version` を追加し、manifest/overviewを
`${file}.visual-v2/${run}/publications/${version}/manifest.json|overview.json` へ保存する。
最初の公開版だけをDBへ採用し、APIはDBで選択された版のキーを読む。
チャンク・manifestとも回収済みattemptの再登録は拒否し、再試行は新しいUUIDを使う。
古いleaseから外部DELETEが遅れても、キーが違うため新しい採用版を削除しない。

### 猶予と移行上の注意

回収開始までは1時間の猶予を設ける。これは現在のTerraformが各通常Lambdaを900秒以下に制限する構成を前提とする。
[AWSのtimeout仕様](https://docs.aws.amazon.com/lambda/latest/dg/configuration-timeout.html)も参照。
Managed Instancesなど長時間実行方式へ変更する場合は、この猶予・PUTの終了条件を再評価する。
実R2でのPUT中断・削除失敗・タイミング試験は本番切替前の残作業である。

新台帳は登録後の書き込みを回収する仕組みであり、既存バケットの未登録の孤立画像を自動で列挙するものではない。
過去の孤立オブジェクトは移行時のinventory照合で確認する必要がある。
cleanedの識別情報は現在保持し、版の再利用を防ぐ。長期保持量を容量評価に含め、削除方針を別途検証する。
旧ready runにはpublication_versionがないため、データ移送時にはmanifestの変換または再生成が必要。
PostgreSQLのスキーマ・保存方式は変更しない。

検証: workerd D1・署名API・スケジュール・読出しに関する45件、Pythonの回収/署名client12件が成功。
期限切れPUT、採用版保護、動画削除後の回収、部分削除再試行、古いlease、並行manifest公開と負けた版だけの回収を確認した。

この変更後の追加回帰: 既存の読出し・RAG試験105件、Python全体576件（114件スキップ）、Workers58件が成功。
API型チェック・lint・オンプレミスNodeビルド・D1 Drizzle checkも成功した。

## 続行実装: 全件再索引ジョブのD1候補ページ

`ReindexRepository.candidateIds(afterId)` をD1とPostgreSQLへ実装した。
completedかつ空でない字幕を持つ動画IDだけを昇順に最大26件取得し、25件の配送と次ページ判定に使用する。
日時や字幕本文をWorkerへ転送せず、削除で先行行が消えてもoffsetによる飛ばしが発生しないkeyset方式を継続する。

署名API `/internal/worker/reindex/page` は候補がある場合、API/WorkerのEmbeddingモデル・profile・次元を照合し、
Vectorizeのdescribeでbindingの次元を確認してからIDを返す。不一致・provider障害は固定エラーで再試行対象とする。
空ページはVectorizeへの問い合わせを省略する。
距離指標やメタデータ索引の実設定はこのdescribe次元検証だけで保証せず、実リソース構築・移行検証の対象とする。
参照: [Vectorize client API](https://developers.cloudflare.com/vectorize/reference/client-api/)。

Pythonの `reindex_all_videos_embeddings` はD1選択時、このAPIから候補を取得して既存SQS search queueへ配送する。
安定したroot/child job ID、25件単位の配送、継続ジョブを最後に送る方式を維持する。
pgvectorのstorage検査やPostgreSQL advisory lockは呼び出さない。
クラウドでsearch queueがない場合は明示的に失敗し、PostgreSQLや一つのLambdaでの全件処理へフォールバックしない。
オンプレミスでは既存の直接SQL・pgvector検査・ローカル直列処理も維持する。

検証: 共通契約3件をworkerd D1と実PostgreSQLで実行し計6件成功。
署名APIの既存経路を含む10件、Pythonの新旧dispatcher31件が成功。
途中配送失敗の再試行、ページ境界のID保持、カーソル上限、順序不正・重複ID・過大ページの拒否、モデル/次元不一致の拒否を確認した。
Python全体は584件成功、114件スキップ。実Vectorize/SQSの試験と本番切替は未実施。

768次元の別bindingを選ぶprofile試験も成功。API型チェック・lint・オンプレミスNodeビルド成功。

## 続行実装: AI回答枠の共通契約

`AiQuotaRepository` を追加し、チャットが利用する既存のreserve/release facadeをD1/PostgreSQLへ接続した。
予約は上限判定・UTC月替わり・AI使用量加算・処理時間の月次リセットを条件付きUPDATEで確定する。
D1は予約結果と拒否理由を同じbatchで読み、planCode/quotaSourceを共有DTOへ返す。
返却は予約時のusagePeriodStartをそのまま条件として使い、新しい期間の使用量を減算しない。
PostgreSQLのtimestamp文字列は精度を落とさず維持し、D1はUTC ISO文字列を使う。
移行時はusage_period_startを正規化・照合し、未変換のPostgreSQL文字列表現を単純にコピーしない。

既存PostgreSQLの予約・返却SQLは変更せずアダプターへ移した。
容量・アップロードのPostgreSQL用transaction primitiveも同アダプター配下へ移し、既存呼び出し名は互換exportで維持する。
これらのprimitiveを使う残存業務操作のD1移植が完了したとは扱わない。
AI返却も既存の一回呼出し契約を維持しており、同じ予約を任意に繰り返して返却できる冪等性IDを新設したものではない。

検証: 共通契約6件をworkerd D1と実PostgreSQLで実行。既存の予約・容量の試験を含め18件成功。
チャット送信・実行・ストリームとD1処理利用枠の回帰82件が成功。
並行上限、同期間への返却、古い期間の返却拒否、AI/処理枠の月替わり競合、独立したupload使用量の維持を確認した。
API型チェック・lint・オンプレミスNodeビルド成功。実データ移行と本番切替は未実施。

Workers実行環境での既存試験58件も成功した。

## 続行実装: チャット履歴・評価・分析

`ChatRepository` を業務契約として導入し、既存facadeをD1/PostgreSQLへ接続した。
講座文脈の取得、構造化回答の保存、所有者の履歴一覧・CSVページ・分析、評価更新、履歴削除、共有slugの確認を対象とする。
共有投稿者を匿名化し、native membership/共有リンクからLMS管理教材を参照できない境界を維持する。
LTIのcourse/video grantはサーバー内部入力として扱い、保存時にはsession proofの期限・registration・subjectをDBで確認する。
回答ログとLTI帰属行は同じbatchで保存し、帰属失敗時に回答だけを残さない。

履歴削除では所有者ガード、会話行・履歴行の削除を同じD1 batchで確定する。
評価更新も対象の存在・権限判定・更新を同じbatchで行い、notFound/forbiddenを区別する。
CSVは100行単位のcreated_at/id keysetとし、カーソルのtimestamp精度をJavaScript Dateへ落とさない。
D1の新規chat_logs.created_atはUTC・小数6桁固定で保存する。移行時もこの形へ統一し、
可変精度・異なるtimezone表現をそのままTEXT比較へ混在させない。API表示は従来どおりUTC ISOミリ秒とする。
分析はUTC日付・NULL feedbackの意味を維持し、空文字のfeedbackをnoneへ勝手に含めない。

PostgreSQLの既存SQLはアダプターへ移し、conversation transaction用のcreateChatLogWithDbは互換exportとして残す。
LangGraph checkpoint・会話lease・turnの確定経路は引き続き移植対象であり、チャット全体のD1対応完了とはしない。
LTI認証・privacy管理など周辺操作の全移植も未完了である。

検証: 共通契約9件をworkerd D1と実PostgreSQLで実行し、計18件成功。
LTI帰属失敗時の回答rollback、履歴削除失敗時の会話rollback、共有投稿者の匿名化、scope制限、105件の同時刻CSV境界を検証した。
既存チャット・LTIルート133件、実PostgreSQLの履歴・分析・評価42件も成功。
API型チェック・lint成功。実データ移行・本番切替は未実施。

オンプレミスNodeビルドとWorkers試験58件も成功した。

## 続行実装: D1用LangGraph checkpoint saver

LangGraphの `BaseCheckpointSaver` を実装するD1用saverを追加した。
メッセージ履歴へ置き換えず、checkpoint snapshot・channel versions・親ID・metadata・pending writes・namespaceを保存する。
serializerはLangGraphのtyped serializerを使用し、HumanMessage等の型を復元する。
0008でcheckpoint/writesの2テーブルを追加し、D1は65テーブルになった。
conversationへのFKを持ち、会話削除時にはモデル状態と途中の書き込みもcascadeで削除する。

saverは一つのthread/leaseへ固定したrequest-scopedインスタンスであり、全SQLで有効なleaseと期限を確認する。
古いleaseや別threadへの読書きは拒否する。複数の途中書き込みと削除はD1 batchで確定し、SQL失敗時に一部だけを残さない。
通常の再配送writeは最初の値を保持し、特殊writeは既存PostgresSaverと同じ更新規則を使用する。
pending writesはSDKのtask path/task ID/indexの比較関数で並べ、Unicodeの順序も独自に変更しない。
旧v3 checkpointのpending sends復元と、分岐の親チェーンに沿ったdelta履歴読出しを確認した。

この段階では全スナップショットを保存する。D1 row予算としてserialized checkpoint/metadata合計1.8MBを超える状態を拒否し、
途中writeは一回128件・合計1.8MB以内とする。listは20件ずつ取得し、scalar metadata filter・before/limitを検証した。
PostgreSQLのchannel blob重複排除と同じ容量になるとは扱わず、実会話での容量・性能を移行前に計測する。
`@langchain/langgraph-checkpoint` を直接依存へ追加し、既存のlock済み1.2.2の公開interfaceを使用する。
lockfileの無関係なplatform/workspace変更は残さず、PostgreSQLスキーマ・履歴も変更していない。
参照: [LangGraph persistence](https://docs.langchain.com/oss/javascript/langgraph/persistence)。

検証: 同じ6件のcheckpoint契約をworkerd D1・実PostgresSaver・MemorySaverで実行し計18件成功。
実際のLangGraphで、新しいsaverからの再開、親指定の分岐、interrupt/Command再開を確認した。
lease期限切れ・差し替え・別thread拒否、会話削除のcascade、過大状態の拒否、途中SQL失敗のrollbackも検証した。
既存会話試験・schema parityを含む追加19件が成功。
API型チェック・lint・Nodeビルド・D1 Drizzle check成功。

未完了: アプリのopenConversation/lease取得・回答log/turn/commit pointerの確定への接続、
会話一覧・削除・LTI再認可・retention経路のD1化、既存PostgreSQL checkpointの取込リハーサル。
現在の本番会話経路をD1へ切り替えたものではない。

Workers実行環境の既存58件も成功した。

## 続行実装: 会話lease・回答確定・履歴の二環境対応

会話のopen/lease取得と回答確定を業務契約へ分離し、PostgreSQLの既存transactionは専用アダプターへ移した。
共通message-serviceの回答保存コールバックは `CreateChatLogInput` を準備するだけになり、Drizzle/SQLハンドルを受け取らない。
D1はleaseとcheckpointの存在を条件に、回答ログ・LTI帰属・turn・確定checkpointポインターを同じbatchで保存する。
古いleaseのcommit/closeは新しい処理の状態を変更しない。SQL失敗時には回答ログもrollbackし、途中のモデルcheckpointは再開時に採用しない。

会話一覧・詳細・削除も共通Repositoryへ分離し、サービスからpg.ClientとSQLを除去した。
アダプターで日時・boolean・turn ID・JSONを共通型へ正規化し、共有評価トークンの発行と回答引用の最終scope検証は共通サービスに残す。
共有ブラウザIDと候補conversation IDの組み合わせ、本人だけのLTI履歴、生成中の削除拒否、教材範囲が縮小した場合の履歴非表示を維持する。
LTIのopen/commit/read/deleteは現在のcourse所有・教材所属・存在するsession proofの期限と主体をD1 batch内で再確認する。
教材scopeが空でも自分の履歴を削除できるが、モデル記憶のopen/commitは許可しない。
期限切れ会話とLTI帰属ログの保持期限処理もD1 batchで実装した。削除件数はcascade件数を含めず会話数を返す。

検証: 共通の履歴契約6件を実PostgreSQLとworkerd D1で実行し計12件成功。
D1固有10件ではlease競合・失効・差替え、古いclose、checkpoint不在、ログ準備失敗、SQL途中失敗、二重確定、
LTI所属失効・scope縮小・期限切れ再作成、retention、削除失敗時のlog/checkpoint維持を確認した。
実アプリrunChatRagによる新規回答・保存失敗・再開を実行し、未確定の質問が後続モデル入力に入らないことも検証した。
既存PostgreSQL会話・D1チャットログを含む40件と、既存チャット送信・履歴・LTIルート等を含む168件が成功。
API型チェック・lint・オンプレミスNodeビルド成功。

未完了: LTI認証ストア・privacy/account管理・course管理等の周辺経路の全移植、
PostgreSQL checkpointを含む既存データの移行リハーサル、実D1での容量/性能、Vectorize検索品質と本番切替。
ローカルworkerdでの成功を本番D1の検証完了とは扱わない。本番設定・データは変更していない。

最終検証: LTI session失効時のopen/commit/list/detail/deleteを追加し、既存PostgreSQL会話を含む46件が成功。
API全体は1,516件成功・927件skip（DB等の実行条件付き試験）、Workersは58件成功。
全体試験後に追加したsession失効対応は上記46件・型チェック・lint・Nodeビルドで再検証した。

## 続行実装: 動画・タグ・講座の関連付け

MembershipRepositoryを業務契約として追加し、タグ付与/解除、講座への単体追加/削除・一括追加、講座内動画の並べ替えをD1とPostgreSQLへ分離した。
既存PostgreSQLの所有行ロック・share lock・transaction・SQLは専用アダプターへ移し、その意味を維持する。
共通membership façadeは具体的DB型やDrizzle schemaを参照しない。course-repositoryのreorderVideosも同じ契約へ委譲する。

D1は検証のSELECTと条件付き書き込みを同じbatchで行い、検証失敗で一部の関連付けを追加しない。
動画/タグ/講座の所有関係、既存の他人のタグリンクの再利用、重複入力、再実行時の追加件数を維持する。
講座と動画がLMS管理の場合の新規追加を拒否し、所有するlegacy LMS動画の講座からの除去は許可する。
一括追加は入力の初出順に未所属動画だけを末尾へ追加し、並べ替えは全所属動画の一意な順列だけを受け付ける。
batchの原子性で同時追加を直列化し、途中のSQL失敗時は追加全体をrollbackする。
動画ID配列はJSON parameterとして渡し、大きなIN句やIDごとのSQL呼び出しに展開しない。

検証: 共通契約8件をworkerd D1と実PostgreSQLの両方で実行し、計16件成功。
重複/欠損/他人のリソース/LMS制約、重複した同時単体・一括追加、順序の完全性、途中SQL失敗を検証した。
既存タグ付与・講座追加・講座/動画順序・サービス試験を含む104件成功。
型チェック・lint・オンプレミスNodeビルド成功。

残り: 講座の作成/読出し/更新/削除/共有設定/講座自身の並べ替え、招待・ユーザー所属、LTI認証ストアなどの移植は未完了。
本番へのDB切り替え・データ移行は引き続き未実施。
Workers実行環境の58件も成功。cloud editionからfactory経由で選ばれるD1実装の8契約も再実行して成功した。

## 続行実装: 講座管理の二環境対応

CourseRepositoryの共通契約へ、講座一覧・詳細・共有リンク読出し・RAG用の限定メタデータ、
作成・更新・削除・講座自身の並べ替え・共有slug設定/解除・所有確認を分離した。
既存の公開repositoryはfactoryへの委譲と共通型のexportのみになり、PostgreSQLのSQL/lock/transactionは専用アダプターへ移した。
D1もDrizzleで読出し/更新し、作成台帳・削除・並べ替えなど複数SQLの整合性が必要な業務操作は原子的batchで扱う。
動画の共通projectionはD1動画readアダプターと共有し、タグ・visual処理状態・URL省略の意味を維持する。

D1の作成は同一batchで講座とMCP冪等性台帳を保存し、同じkey/hashなら同じIDを返し、異なるhashは競合とする。
キーなしの作成に使う内部台帳はbatch終了前に削除する。同時作成でもユーザーごとの末尾表示順を重複させない。
講座並べ替えはMATERIALIZED CTEで変更前の選択行のslot値を確保し、既存値の集合を指定順へ再配分する。
講座削除では作成台帳とcourseを同じbatchで削除し、所属・ログ・会話等はFKでcascadeする。元動画は削除しない。

所有者の運用アクセスを維持しつつ、招待メンバーと公開リンクにはLMS制約を適用する。
LMS管理講座、LMS動画を含むlegacy講座、native_access_disabledの講座を外部アクセスに公開しない。
更新・削除のLMS制約、共有slugのcase-insensitiveな一意性と公開lookupの完全一致、
解除時のnotFound/notConfigured、updated_atを変えない既存の更新契約を維持した。
RAGメタデータはSQLite substrとPostgreSQL leftのコードポイント単位を合わせ、従来のlimit+1の文字列を返す。

検証: 講座の共通契約12件をworkerd D1と実PostgreSQLで実行し、計24件成功。
認可、LMS制約、オプション付き動画ページング、Unicode、同時作成、冪等性、SQL失敗時のrollback、
共有slug競合、並べ替え、関連ログ/会話/所属のcascadeと元動画の保持を確認した。
D1動画読出し・所属契約を含む35件と、既存PostgreSQLの講座読出し・削除・順序・RAG・Moodle権限99件も成功。
型チェック・lint・オンプレミスNodeビルド成功。

未完了: 招待・ユーザー所属、LTI認証ストア・privacy/account・課金等の周辺経路、
既存データの移行・本番D1/Vectorizeでの容量/性能/検索品質検証・本番切替。
本番設定とデータには変更を加えていない。
追加のMCP・チャット・backend選択等78件と、Workers実行環境58件も成功した。

## 続行実装: LTI / OAuth認証情報ストア

CredentialRepositoryへ、有効期限付き認証情報の保存/読出し、一度限りの消費、教材スコープの追加、期限切れ削除、LTI評価参照の保存を分離した。
LTI storeサービスはDB具体型やschemaを参照しない。sessionRecord検証と有効期限の決定は共通サービスに維持する。
PostgreSQLの既存SQL/transactionとセッションのowner/share lockは専用アダプターへ移した。
セッション証明の型/検証は共通のpure moduleに置き、D1のLTI主体検証からPostgreSQLロックmoduleへの依存を除去した。
未移植の既存PostgreSQL機能にはdata-lockの互換exportを残す。

D1はDrizzle SQLiteで認証情報を保存・取得・消費・期限切れ削除する。
DELETE RETURNINGで一つのlogin/OAuth stateを複数の処理が消費できないようにし、教材スコープの和集合は単一UPDATEで追加する。
教材スコープの更新で他のclaimsや期限は変更しない。SQLite json_eachがbooleanを0/1として返す点に対処し、JSONの型を保持する。
不正な保存済みboolean/nullを動画IDとして承認せず、PostgreSQLと同じく不正なスコープとして返す。
LTI評価参照の作成は現在のcourse所有者とsessionの種類/期限/registration/subjectを同じINSERT内で確認し、
失効・削除・主体差替え後の遅延処理から参照を再作成させない。

検証: 同じ8契約をcloud D1(workerd)と明示的onprem PostgreSQLで実行し計16件成功。
JSON roundtrip、kind/期限分離、重複キー拒否、8件の同時消費、教材スコープの同時更新、期限維持、
不正JSON型、評価参照の失効/主体検証、および共通store/sessionRecordサービス経由の保存を確認した。
LTIルート・maintenance等を含む64件、D1チャット/会話を含む39件が成功。
既存PostgreSQLネイティブセッション・privacy・会話44件と、LMS同期59件も成功。

未完了: LTI登録/署名鍵・LMSネイティブセッション/権限/同期/履歴/privacy等の残るDBアクセス、
招待・ユーザー所属・課金/account管理、既存データ移行・実D1/Vectorize検証・本番切替。
この認証情報ストアの移植だけでLTI全体のD1対応が完了したとは扱わない。本番設定・データは未変更。
型チェック・lint・オンプレミスNodeビルド、およびWorkers実行環境58件も成功した。

## 続行実装: LTI登録解決と署名鍵

LtiRegistrationRepositoryのsnapshot契約へ、稼働中の接続と有効な教材候補の読出しを分離した。
PostgreSQLとD1はそれぞれのschema/ORMで取得し、登録の組み立て・YouTube機能判定・所有者照合・static登録との重複拒否は共通サービスで実行する。
D1はactive/deactivated/banned/ban expiryを確認し、courseのLMS管理とnativeアクセス無効を同じ読出しbatchで検証する。
動画所有者・講座所有者、manifest/実体のYouTube IDは区別して保持する。
D1 batchで重複するuser_id/YouTube列が欠落しないようSQL aliasを付け、snapshotの共通契約で所有者情報を確認した。

ToolKeyRepositoryでは暗号化済みkey ringだけを永続化層へ渡す。
RSA生成・key ring検証・AES-GCMの既存purpose binding・JWKS公開・JWT署名を共通処理に維持し、DBからの読出しはD1/PostgreSQLを選択する。
D1の管理鍵初期化はINSERT ON CONFLICT DO NOTHINGとSELECTの同一batchで、一つの暗号化鍵だけを採用する。
オンプレミスの共通初期化は既存と同じadvisory lockを取り、旧transaction内初期化との競合も防ぐ。
現在のPostgreSQL Moodle pairingは所有者認証と同じtransaction/接続で初期化する経路を維持する。
そのtransaction専用処理はPostgreSQLアダプターへ移した。pairing全体のD1移植はまだ完了しておらず、
新しい共通ensureManagedToolKeysは、認証済み業務操作から呼ぶための初期化入口である。

保存形式・鍵ID・暗号化purposeは変更しない。static key設定はDBなしで使用でき、重複する公開鍵を除去する。
JWKSには公開成分だけを返し、暗号文破損・暗号化鍵不一致・DBエラーは秘密値を含まない既存のエラーメッセージで失敗させる。

検証: 登録設定の共通6契約をworkerd D1と明示onprem PostgreSQLで実行し計12件成功。
接続/アカウント失効、外部所有者/非LMS講座/無効教材の除外、YouTubeの実体照合、legacy authority、static重複を確認した。
署名鍵の共通4契約も両DBで実行し計8件成功。
同時初期化・暗号化保存・公開成分限定・再読出し安定性、署名JWTの検証/kid/60秒期限/jti、static設定、破損/鍵変更時の拒否を確認した。
既存LMS同期・LTIルート96件、API型チェック・lint・オンプレミスNodeビルドも成功。

未完了: Moodle pairing・LMS同期・native session・権限/履歴/privacy等の残るDBアクセス、招待・課金/account管理、
移行ツールと実D1/Vectorize検証・本番切替。本番の設定・鍵・データは変更していない。
Workers実行環境の58件も成功した。新しい契約は既存CIのtest:unitで自動検出され、PG用環境変数もCIで設定済みである。

## 続行実装: Moodle pairing

MoodlePairingRepositoryへコード発行と接続交換を業務操作として分離した。
URL/schema検証、secret/hash生成、PKCEの共通規則、応答のupload policy生成、maintenance起床は共通サービスに残す。
PostgreSQLのowner/code行ロックと署名鍵初期化は専用アダプターで同じtransaction/接続を使う。

D1の発行はactive ownerと暗号化署名鍵の一致を確認し、鍵・コード・最新owner pointerを同じbatchで保存する。
RSA生成中に別の初期化が勝った場合は、勝者の暗号文を読み直して復号/検証してから発行する。
負けたbatchはコード/pointerを書かず、最大3回で失敗させる。アカウントが途中で無効になった場合も鍵やコードを残さない。
古いcode行はowner pointerの切替で失効し、交換時に最新pointerと照合する。

D1の交換はcode/receiptのsnapshotに対してschema/PKCEを検証した後、書込みbatch内で同一payload・期限・owner・pointer・接続競合を再確認する。
接続作成/更新・materials retry receipt・code/pointer削除を同時に確定し、SQL途中失敗で一部だけ残さない。
materialsの同時再試行は同じ接続を返し、legacyコードは一つの交換だけが消費できる。
別所有者は同じ接続を再利用できず、失効済み接続やpointerを古いコードで復活させない。
公開codeに含むsecretとsync tokenの原文は保存しない。

共通の同時交換試験で、従来PostgreSQLではcodeロック待ち中に先行交換がcommitするとreceiptを再読出しせず401になる競合を検出した。
ロック待ち後にcodeが消えていればmaterials receiptを再検証するよう修正した。
また、別ownerが同じissuer/clientを同時作成した場合は、unique競合をCONNECTION_EXISTSとして返して負けたcodeを保持する。

検証: 共通12契約をworkerd D1と明示onprem PostgreSQLで実行し計24件成功。
同時初回発行/鍵採用、最新pointer、legacy一度限りの消費、PKCE/issuer/mode/期限、materials再試行、
同一所有者の再接続、他所有者の競合、失効、鍵/code/接続/receiptのrollbackを確認した。
共通サービスからの実際の発行・交換も実行し、DB確定後のupload policy生成失敗から同じ接続で復帰できることを検証した。
D1固有の追加3件で、RSA生成後のアカウント無効化、PKCE検証後のcode payload変更、receipt読出し後の切断を注入し、いずれも保存/再利用を拒否した。
既存LMS同期・LTIルート96件、型チェック・lint・オンプレミスNodeビルド成功。

未完了: LMS installationの管理/認証/切断経路と同期・native session・権限/履歴/privacy等、
招待・課金/account管理、既存データ移行・実D1/Vectorize検証・本番切替。
本番設定・既存接続・鍵・データは変更していない。
Workers実行環境58件も成功した。legacy同時交換の負け側がSQLエラーではなく401を返す追加確認も両DBで成功した。

## 続行実装: LMS接続管理・認証・切断

LmsInstallationRepositoryへoperatorによる接続作成、push token認証、token更新、active接続一覧、切断を分離した。
公開repositoryは入力schemaとtoken生成/hashを共通化し、DB処理をfactoryへ委譲する。
Moodleの一覧HTTPルートも共通のlistActiveLmsInstallationsを使い、DB型・schema・SQLを参照しない。
PostgreSQL用active owner predicateとpairing pointer失効SQLはアダプターへ移し、未移植の同期処理はそれらを明示的に参照する。
不要になったfeature内のlifecycle moduleは削除した。

D1はactive/deactivated/banned/ban expiryを認証と一覧・作成・切断で再確認する。
push tokenはhashだけを保存し、materials service接続にはpush tokenを発行/更新しない。
token更新は既存どおり所有権と接続modeを条件に単一UPDATEで行い、LTIのidentityは変更しない。
切断はactive ownerと所有権を条件に接続を無効化し、そのowner/issuerの未使用pairing pointerを同じbatchで削除する。
古いコードで接続を再有効化させず、失効済み接続のmaterials receiptも再利用できない。
学習データ・接続自体・既存認証情報の本体は削除しない。pointer削除失敗時はactive flagもrollbackする。

検証: 同じ9契約をworkerd D1と明示onprem PostgreSQLで実行し計18件成功。
provision schema/一意制約、token hash、service mode分離、同時token更新、他所有者拒否、account失効/ban期限、
pointer/receipt失効、再切断、SQL途中失敗を確認した。
接続の切断とpairing交換を同時実行し、どちらが先に確定しても切断後に接続が復活しないことを確認した。
登録解決の回帰試験を含む30件、既存LMS同期・LTIルート96件が成功。
型チェック・lint・オンプレミスNodeビルドも成功。

未完了: LMS resource同期・materials同期・native session・権限/履歴/privacy等の残るDBアクセス、
招待・課金/account管理、移行ツール・実D1/Vectorizeでの検証・本番切替。
本番の接続・token・鍵・データ・設定は変更していない。
最終の型チェック・lint・Nodeビルドと、Workers実行環境58件も成功した。

## 続行実装: LMS resource契約とD1読出し

既存のLMS resource同期・grantロック・削除/利用枠/ジョブ処理をPostgreSQL専用アダプターへ移した。
共通側はmanifestの機能/identity検証とhash生成を維持する。SQLのtransaction内の処理順は変更していない。
既存のgrantロックを必要とする未移植の教材管理・タグ・レポート・content uploadはPostgreSQLアダプターを明示的に参照する。

LmsResource/LmsResourceVideo/LmsResourceDataと読出しの共通契約を追加し、Drizzleの推論型を共有サービスの返却型にしない。
D1の読出しはresource/installation/ownerと動画のSELECTを同じbatchで実行し、joinの同名列でid等が欠落しないようテーブルごとのprojectionに分けた。
接続のowner・activeとアカウントのactive/deactivated/ban期限を毎回照合する。
両DBでresourceの更新日時、動画のupload日時・heartbeat・usage periodをUTC ISOへ正規化し、boolean/数値/JSON multipart状態を共通の値として返す。
無効教材や動画pointerのないtombstone/course entryも同期照合用に読出せるが、接続・アカウントが無効なら返さない。

検証: 同じ5契約をworkerd D1と明示onprem PostgreSQLで実行し計10件成功。
完全なmetadata、idの区別、UTC日時、boolean/数値/JSON、所有者/接続/外部identity/SQL入力の分離、
失効/ban期限、disabled source、null動画・course entryを確認した。
既存PostgreSQLのLMS同期・privacy・教材タグ77件、型チェック・lint・オンプレミスNodeビルドが成功。

重要: resource同期のD1書き込みは未実装。現在の同期確定はPostgreSQL専用であり、D1選択時は既存connection guardが接続を拒否する。
暗黙のPostgreSQLフォールバックはしない。この変更だけでD1の教材同期が利用可能になったとは扱わない。
次の実装には、resource/動画/講座mappingと認可をbatch内で再照合する条件付き確定、利用枠・月跨ぎ/refund、
共有教材削除の拒否、storage cleanup/遅延cleanupとVectorize削除Outbox、context移動時のタグ解除、
YouTubeジョブとcourse entryの意味をまとめて移植し、同じ同期契約で検証する必要がある。
本番設定・データは未変更であり、他の未移植機能と実データ移行・実D1/Vectorize検証・本番切替も継続対象である。
Workers実行環境の58件も成功した。

## 続行実装: D1 LMS resource同期の原子的確定

LmsResourceSyncRepositoryを導入し、同期書込みのfactory選択をD1/PostgreSQLへ接続した。
前節の「D1同期書込み未実装」の状態はこの実装で解消した。同期protocol全体や他のLMS機能の完了を意味するものではない。

D1はgrantを確認し、resource・context mapping・動画・旧講座・course entry・削除対象の共有参照をsnapshotとして取得する。
依存する読出しを二つのbatchへまとめ、認可と確定を含め通常4回のDB往復で処理する。
確定batchは各snapshotと現在値の一致・grant/accountの有効性を確認して業務receiptを作成し、全書込みをそのreceiptへ従属させる。
競合したbatchは何も確定せず、最大5回読み直す。新しいgenerationや共有参照を古い準備結果で上書き/削除しない。

確定対象には、LMS provenanceの補修、membership/context移動と旧courseタグ解除、動画とcourse/mapping、resource generation/hash、
upload/storage quotaと未確定uploadの月別refund、YouTubeジョブのdurable outbox、ストレージ削除と2時間後のlate-upload cleanupを含む。
月跨ぎをまたいでquotaを再計算しないよう、確定batchで一つの月境界をreceiptへ保持して動画と利用量へ共通適用する。
削除前にcurrent/stagedの不変vector IDの削除Outboxを保存し、D1の動画/scene/runがcascadeしてもVectorize削除を再試行できる。
metadataだけの変更、disabledと再有効化、明示tombstone、course entryとsource kind、言語のupload時固定の意味を維持する。
quota超過は部分割当をせずblocked resourceを保存し、同じgenerationをquota回復後に再同期できる。

共通契約の整合性を保つためPostgreSQLでも、不正な他accountの動画/context mappingをprovenance補修前に拒否するようにした。
削除したlegacy/native動画のMCP作成台帳も同じtransactionで削除し、削除済みIDを再利用しない。
既存LMS試験fixtureには、実際のschemaからMCP台帳を生成する処理を追加した。
既存のPostgreSQLマイグレーション履歴は変更していない。

D1の共有参照検索用にlms_resources.video_idのindexをschema/0009へ追加した。テーブル数は65のまま。
workerdのEXPLAIN QUERY PLANでlms_resources_video_idxの使用を確認した。
これは検索の索引使用の検証であり、本番のlatency/cost比較を実施したという意味ではない。

検証: 同じ20契約をworkerd D1とPostgreSQLで実行し計40件成功。
YouTubeはonpremでの拒否も確認し、PGでの書込み動作比較は明示したcloud PostgreSQL移行設定で行った。
quota・月跨ぎ・世代/冪等性・同時新規/更新・metadata/言語・無効化/置換/削除・YouTubeジョブのwire payload・course entry・
共有拒否・contextタグ解除・provenance/所有権・最終保存失敗時のrefund/outbox rollbackを確認した。
D1追加5件では確定直前の接続失効・新世代・quota変更・共有参照追加と、current/staged vector削除の永続化を確認した。
既存LMS同期59件を含む102件成功。新しいindex migration適用後のD1同期/競合24件も成功。
型チェック・lint・Nodeビルド・D1 Drizzle checkも成功。

未完了: LMSの非direct content upload制御、materials同期のlease/export状態、native session・権限/履歴/privacy、
招待・課金/account管理等、既存データ移行・実D1/Vectorizeの性能/検索品質・本番切替。
本番の接続・データ・設定・D1マイグレーション適用は行っていない。

追加検証: 内部呼出しでも不正な予約byte数がquotaを減らさないよう、D1もPostgreSQLと同じ正の安全整数検証を行う。
この追加を含む共通40件が成功し、YouTubeジョブのvideo_idが保存済み動画へ一致することも両DBで確認した。
Workers実行環境58件も成功した。
返却値のUTC正規化は両アダプター内部で行い、共通facadeからDB固有の返却形式を除去した。変更後の新規/冪等な同期4件と最終型チェック・lint・Nodeビルドも成功した。

## 続行実装: Materials同期状態の共通化

MaterialsSyncRepositoryを導入し、materials-syncからPostgreSQL/Drizzle依存を除去した。
context lease、export attempt/job、poll lease/cursorをD1とPostgreSQLへ実装した。
接続・所有者・ban・設定snapshot・期限・tokenを検証し、古い処理による状態上書きを拒否する。
contextとpollの権限を分離し、古いfinallyによる新leaseの削除を防ぐ。
export要求前にattemptを保存し、HTTP応答を失っても同じ冪等性キーを再利用する。

resource同期の確定にもcontext lease証明を渡し、D1 batchとPostgreSQL transaction内で再検証する。
PostgreSQLでは所有者・接続・leaseをロックし、待機中のlease再取得や接続変更との競合を防ぐ。
取得したresourceの世代/video IDが変わった場合は古いmanifestからのexportを抑止する。
pollはcontextを重複除去・整列し、永続cursorで順番に同期する。schema/migration追加は不要。

検証: 共通状態契約9件をworkerd D1とPostgreSQLで実行し計18件成功。
D1実フロー5件ではexport/upload確認/ジョブ発行、応答喪失の再試行、遅延応答、世代変更、pollを確認した。
外部HTTPと配送はテスト境界で代替している。既存LMS同期59件を含め82件成功。
Workers環境58件、型チェック・lint・Nodeビルドも成功した。

残る制約: upload確認は呼出し前にleaseを検証するが、ストレージ確認後のDB確定に同じ証明を渡していない。
その待機中の失効まで含む厳密なfencingは追加対応が必要。大きなmanifestのD1クエリ予算と、
可視性失効を維持した分割処理も未検証/未実装であり、本番対応完了とは扱わない。
非direct content upload、native session・権限/履歴/privacy等、実データ移行、
実D1/Vectorizeの性能・検索品質・費用検証、本番切替は継続対象。本番設定・データは変更していない。

## 続行実装: Materialsアップロード確定時の検証

前節のupload確認に関するリース検証の不足を解消した。MaterialsSyncRepositoryに業務操作confirmUploadを追加し、
ストレージHEAD完了後、現在のcontext lease・接続設定・所有者・resource世代・video ID・file key・enabled状態を
DBで検証してから動画をpendingへ更新し、処理ジョブをOutboxへ保存する。
D1は同一batch、PostgreSQLは所有者/接続/lease/resourceをロックしたtransactionで確定する。
古いリース、pollリース、置換済み教材、不一致のfile keyでは動画もジョブも変更しない。
ストレージサイズが不一致の場合は確定せず、現在の予約を保持してエラーにする。
遅延した確認によって新しい教材の予約を削除することを防ぎ、後続の再送/明示的な再同期で回復可能にする。
export開始とYouTube無効のACK直前にもリースを再検証する。

PostgreSQLの状態契約fixtureを実際のDrizzle schemaから生成する構成へ更新した。
これによりmaterials_cursorがbigint文字列として返る問題が判明し、アダプター内で安全な非負整数へ正規化した。
共通契約11件をD1/PostgreSQLで実行し計22件成功。D1実フロー8件と既存Materials試験35件を含む65件が成功した。
追加試験ではHEAD待機中のリース失効・教材置換、誤ったサイズでの予約保持、確定の重複実行を検証した。
Workers環境58件、型チェック・lint・Nodeビルドも成功。本番設定・データは変更していない。
大きなmanifestの処理量対策、他機能の移植、実サービス性能/品質とデータ移行・本番切替は未完了。

## 続行実装: ネイティブ学習セッションの共通化

NativeSessionRepositoryを追加し、ensureNativeSessionからPostgreSQL具体型を除去した。
オンプレミスは所有者・セッションの既存ロック方式を維持し、D1は型検証したセッションのsnapshotを
原子的batch内で比較する。既存sessionのpayloadと期限は上書きしない。
新しい署名付きリクエストのnonceを条件付きで記録し、初回だけmetadataを含まないstarted markerとsessionを作成する。
既存markerが残ったままsessionが削除された場合は再作成を拒否する。
scope unionと競合したsnapshotは最大5回読み直し、追加済みの動画権限を失わない。
拒否した要求のnonce/markerを残さず、期限延長、別identity/教材世代との混用、他種credentialとのID衝突を拒否する。
PostgreSQLもmarkerのkindを検証し、共通のsession payload/identity検証を使用する。
スキーマと既存PostgreSQLのmigration履歴は変更していない。

検証: 同じ18契約をworkerd D1と実PostgreSQL schemaで実行し36件成功。
D1追加3件ではreadとbatchの間に実際のscope union/session削除を挟み、再試行と復活拒否を確認した。
session INSERT失敗時にbatch全体がrollbackし、nonceとmarkerも残らないことを確認した。
既存のPostgreSQL消去ロック競合試験とnative API試験を合わせて71件成功。Workers環境58件も成功した。
型チェック・lint・Nodeビルドも成功。本番設定・データは変更していない。
これはnative session永続化の対応であり、権限・履歴・privacy・管理操作を含むネイティブLMS全体の移植完了を意味しない。
非direct content upload、大きなmanifest対応、他機能と実データ移行・実サービス性能/品質検証・本番切替は継続対象。

## 続行実装: 講座学習履歴の共通化

CourseHistoryRepositoryを追加し、history機能からPostgreSQL/Drizzle依存を除去した。
共通facadeは履歴キーの生成、回答schemaと出典の閲覧範囲を検証し、両アダプターは履歴の原子的追記とlog取得を実装する。
同時追記で履歴を失わず直近50件を順序付きで保持する。保存済みscopeが現在のscopeの部分集合でない場合や
期限切れの場合は以前の文脈を破棄する。scope省略時は講座membershipを使用する。
D1の追記は一つの条件付きUPSERTで確定する。readでは認証判定と履歴/log読取りを同じbatchで行う。
PostgreSQLのsession proof付き操作は所有者・sessionをロックし、消去処理との既存の順序を維持する。
readにもsession検証を追加し、証明のsubject/registrationとhistory scopeの不一致を両DBで拒否する。
履歴keyと衝突した別kindのcredentialは書き換えない。回答logは所有者/講座に限定し、出典に閲覧不可の動画が含まれる回答を返さない。

D1のJSON集約はboolean/string/nullを維持し、trueを動画IDの1へ変換しない。
PostgreSQL JSONBから移した整数値の1.0は有効な整数IDとして読み取り・追記できる。
不正なturns構造では回答を返さず、型不正のscopeや非arrayのturnsは次の追記で新しい文脈へ置換する。
既存PostgreSQLの履歴形式とmigration履歴は変更していない。

検証: 同じ15契約をworkerd D1とPostgreSQLで実行し30件成功。
同時追記、直近50件、学校/学習者/講座/所有者の分離、scope縮小・期限切れ、membership、feedback、
不正/他ownerの回答、session失効、proof偽装、credential衝突、JSON値互換を確認した。
既存のLMS同期とLTIルート試験96件、PostgreSQL privacy試験8件、Workers環境58件も成功した。
最終の型チェック・lint・Nodeビルドとgit diff --checkも成功した。
本番設定・データは変更していない。タグ/レポート/教材管理/privacy等の他機能、非direct content upload、
大きなmanifest対応、実データ移行と実サービス検証・本番切替は未完了。

## 続行実装: 講座レポート集計の共通化

CourseReportRepositoryを追加し、講座レポートのビジネス処理からPostgreSQL依存を除去した。
共通処理で期間とserver-derived scopeを検証し、両アダプターは日別の件数だけを返す。
質問/回答本文、学習者の識別情報、個別log IDはSQLの集計結果に含めない。
PostgreSQLでは従来の所有者・接続・session・教材のロック順序を維持した。

D1では完成済みの閲覧可能教材IDを整列・重複除去して準備し、その集合のhashを計算する。
確定batchで接続/account/session/context/courseの有効性を照合し、現在の教材集合が準備時と一致する場合だけ
監査記録を保存する。この監査行をreceiptとして同じbatch内で集計を許可する。
membership/教材世代/有効性/処理状態が変わった場合は監査行を作らず最大5回読み直す。
session失効時は拒否し、監査保存に失敗した場合はbatch全体を失敗させ、集計結果を返さない。
回答時の元scope全体と全出典が現在の閲覧範囲に含まれる回答だけをUTCの日付別に集計する。
未検証の旧logや他installation/context/ownerは除外する。
JSONのboolean/stringを数値IDへ変換せず、PostgreSQL由来の整数値1.0との互換性を維持する。
schemaと既存PostgreSQLのmigration履歴は変更していない。

検証: 共通18契約をworkerd D1と実PostgreSQL schemaで実行し36件成功。
D1追加2件でreadと確定batchの間のmembership変更/session削除を再現し、古い監査行が残らないことを確認した。
既存のレポート・認可・privacy・retention試験15件を含め53件成功。Workers環境58件も成功した。
最終の型チェック・lint・Nodeビルドとgit diff --checkも成功した。
本番設定・データは変更していない。タグ・教材管理・privacy・audit retention等の他機能、非direct content upload、
大きなmanifest対応、実データ移行と実サービス検証・本番切替は継続対象。

## 続行実装: LTI監査メタデータの保持期限処理

AuditRetentionRepositoryを追加し、pruneLtiAuditからPostgreSQL依存を除去した。
設定による明示的なopt-in、1バッチ500件、最大20パスと25秒の実行予算、backlog通知を共通処理へ維持する。
PostgreSQLは従来のreservation lock/SKIP LOCKEDとtransaction rollbackを維持する。
D1は削除候補のid/created_atを取得してnamespaced SHA-256を計算し、同じ候補・日時が残っている場合だけ
permanent replay barrierの保存と期限切れreceiptの削除を同じbatchで確定する。
削除失敗時には新しいbarrierもrollbackする。候補取得後に日時が変更されたreceiptを古い準備結果で削除しない。

material/tagのreceipt本文、reportアクセス記録を期限付きで削除し、LTI moderationはactorの識別情報だけをNULLにする。
native moderator、共有教材、講座タグ、質問本文を変更しない。permanent barrierは操作UUIDのkind別hashだけを保持し、
操作UUIDそのもの・actor・教材本文を含めない。UUIDの大文字小文字でbarrierを回避できない。
hashの共通処理をsharedへ分離したが、D1の教材/タグ管理操作自体は引き続き未移植である。

D1の日時はisoDate/default/import契約によるcanonical UTC ISO textとし、既存created_at/id索引で範囲と順序を処理する。
データ移行時にもこの正規化が必要。既存PostgreSQLのmigration履歴とD1 schemaは変更していない。

検証: 共通7契約をworkerd D1と実PostgreSQL schemaで実行し14件成功。
D1の候補日時変更とEXPLAIN QUERY PLANによる索引使用の追加2件、既存retention/replay試験9件、
既存report/privacy/retention試験15件を含む40件が成功した。
10,001件のbacklogを20バッチで分割し次回完了すること、同時workerの非二重計上、削除失敗時のbarrier rollbackを確認した。
初回検証では補助関数の構文不備と負荷によるhook timeoutが発生し、構文修正後に並列数1・hook timeout 60秒で再実行した。
これはローカルの機能検証であり、実D1の性能・費用検証ではない。本番設定・データは変更していない。
最終の型チェック・lint・Nodeビルド、Workers環境58件とgit diff --checkも成功した。
教材/タグ管理・privacy等の未移植機能、非direct content upload、大きなmanifest対応、データ移行・本番検証は継続対象。

## 続行実装: 管理画面の接続判定と講座タグ操作

LmsInstallationRepositoryへmanagementAccessを追加し、管理画面からPostgreSQL依存を除去した。
利用者のroleとissuer/client/deploymentに一致する所有接続を一つのqueryで取得する。
停止中の接続もownedとして表示するが再有効化せず、管理者roleから他人の接続所有権を推論しない。
billingの表示可否は共通処理のedition判定で決める。この応答は講座アクセスを付与する認証情報ではない。

CourseTagRepositoryを追加し、講座タグのlist/create/update/delete/assignをD1とPostgreSQLへ接続した。
入力schema、catalog投影、assignment revision、現在の教材scopeの絞り込みを共通化した。
学習者には現在読める動画に付いたタグだけを示し、未使用タグは管理者だけに示す。
部分管理者は、自分が管理できない教材と共有するタグを改名/削除できない。
globalな利用者タグとは独立した講座の語彙を維持する。

D1は接続/account/session/courseの認可、現在のresource/membership/status、全タグ/割当、操作receiptとbarrierをsnapshotとして取得する。
確定batchはこれらの業務状態を再照合し、temporary receiptの成立を条件にタグ/割当変更、permanent replay barrier、操作receiptを保存する。
snapshotが変われば最大5回読み直す。古いtag/assignment revisionは409、失効した権限は403として拒否する。
同じ操作UUIDの同時送信は一度だけ実行し、actor/course/requestが一致する再送だけをreusedとして返す。
retention/privacyでreceiptが消えた後もpermanent hashが残るため、UUIDの大文字小文字を変えて再実行できない。
名前の一意制約違反やreceipt保存失敗ではbatch全体をrollbackし、修正した操作の再試行を妨げるbarrierを残さない。
200件上限付近の並行作成もsnapshot照合で上限を超えない。返却catalogは同じbatchで変更後の状態を読む。
PostgreSQLは従来の所有者/接続/session/resource lockとtransactionを維持する。

検証: 共通タグ契約16件をworkerd D1/PostgreSQLで実行し32件成功。
接続の共通契約20件では管理画面の判定も確認し、PostgreSQL fixtureを実際のDrizzle schemaから生成する形へ更新した。
D1追加2件で確定直前の接続失効と新しいtag revisionを再現し、上書きや不要なbarrierが残らないことを確認した。
既存タグ/retention試験19件を含め73件成功。Workers環境58件、型チェック・lint・Nodeビルドとgit diff --checkも成功した。
検証用PostgreSQLはローカルのI/O負荷を抑えるためsynchronous_commit=offを使用した。実サービスの性能や障害復旧性能の計測ではない。
schema/migrationと本番設定・データは変更していない。タグ管理の未移植状態はこの実装で解消した。
教材管理・privacy等の他機能、非direct content upload、大きなmanifest対応、実データ移行・実サービス検証・本番切替は未完了。

## 続行実装: 教材情報の更新・再インデックス・処理再試行

MaterialManagementRepositoryを追加し、教材管理機能からPostgreSQL具体型を除去した。
入力のbyte数/SRT検証、教材revisionと公開用の状態投影は共有し、get/update/reindex/retryを両アダプターへ接続した。
title/source mediaはLMSの正本として変更せず、説明だけの変更では処理ジョブを作らない。
字幕変更ではindexingへ遷移し、空字幕の明示的な保存はallow_empty付きでindexジョブへ渡す。
文字起こしの再試行は元のtranscribe_video job ID/payloadを維持し、既にcompletedのjob receiptを再送しない。

PostgreSQLは既存の所有者/接続/session/resource/member lock、vector writer advisory lockとtransactionを維持する。
D1は認可、resource世代、course、全membership/resource参照、教材本文、直近のジョブ状態をsnapshotとして読み取る。
確定batchでsnapshotと有効な権限を再照合し、操作UUIDのpermanent barrier、教材変更、Outbox、監査receiptを一緒に確定する。
別講座からも参照される共有動画へのdelegated editを拒否し、他講座のidentityを返さない。
古いeditor revision、別actor/requestによるUUID再利用、retired UUIDは409として拒否する。
実行中の動画単位/global reindex job leaseをDBで検証し、確定直前にclaimされた場合もmutationを成立させない。
同じsnapshotを確定できなければ最大5回読み直す。監査保存失敗では本文/Outbox/barrierをrollbackする。

D1の新しいindex処理はsource versionを更新し、current/staged vector削除をOutboxへ保存してscene/stagingを除去する。
古いprovider処理の結果はversion不一致で公開できず、Vectorize削除はdurable taskで再試行する。
D1への新しい字幕保存には既存Workerと同じ1,800,000 byteの予算を適用し、超過は413で拒否する。
共通入力schemaの2MiB上限だけでD1のrow容量を保証したとは扱わない。PostgreSQLの既存上限は維持する。
schema/migrationと本番設定・データは変更していない。実データのサイズ適合性と実D1でのquery性能は別途検証が必要。

検証: 同じ16契約をworkerd D1と実PostgreSQL schemaで実行し32件成功。
既存教材管理12件とretention/replay試験9件も成功した。
D1追加5件では動画/globalの実行中lease、確定直前のclaim、古いscene runのpublish拒否とvector削除task、字幕byte予算を確認した。
初回の追加試験には無効なゼロvectorのfixtureがあり、有効なembeddingへ修正後に5件を再実行して成功した。
保存失敗試験はDrizzleのcauseに含まれる合成エラーを確認した上で、本文/Outbox/barrierのrollbackを両DBで検証した。
関連58件、Workers環境58件、型チェック・lint・Nodeビルドとgit diff --checkが成功した。
検証用PostgreSQLはsynchronous_commit=offであり、実サービスの性能/障害復旧計測ではない。
教材管理の未移植状態はこの実装で解消した。privacy等の他機能、非direct content upload、大きなmanifest対応、
実データ移行・実D1/Vectorizeの性能/品質/費用検証・本番切替は継続対象。

## 続行実装: Privacy認証とデータ操作の境界分離

privacy protocol/schema/subject hashをsharedへ移し、旧privacy-dataからは互換exportを維持した。
PostgreSQL固有のcollection定義・cursor/export・消去SQLとtransactionをpersistence/postgresへ隔離し、
PrivacyRepositoryの業務契約を追加した。Honoのroute内からこれらのSQLを除去した。
これはD1のデータ操作実装の完了を意味しない。executePrivacyRequestは現時点でPostgreSQL adapterを明示的に呼び、
D1選択時は従来のpool guardで拒否する。暗黙のPostgreSQLフォールバックはしない。

PrivacyAuthorizationRepositoryを追加し、署名検証用の登録情報取得と単回nonce保存をD1/PostgreSQLへ実装した。
privacyのrecovery authorityは学習者権限・接続active・ownerのban/利用枠から独立して維持する。
未知のissuer/client/deploymentからJWKSのネットワーク取得先を選ばず、DB内の登録情報を使用する。
nonce保存時にもowner/issuer/client/deployment/JWKS URLを条件付きで照合し、署名検証中の設定変更を拒否する。
nonceにはinstallation IDとactionだけを保存し、要求中のsubjectや個人データを含めない。
同時リプレイ、別kind credentialとの衝突、期限切れのnonce lifetimeを拒否する。
外部assertionで得た登録snapshotにはJWKS URLを保持し、PostgreSQLのデータ操作時にも再照合・ロックする。
直接の内部呼出しとの互換性のためPrivacyInstallationのJWKS URLはoptionalだが、署名検証の返却値には必ず含める。

検証: 同じ認証16契約をworkerd D1とPostgreSQLで実行し32件成功。
実RS256署名、同時リプレイ、audience/purpose/期限/version/署名不正、未知identity、停止/ban/利用制限中の回復、
登録変更・署名resolver中のJWKS URL変更、nonce衝突/期限/metadata、明示的enablementを確認した。
追加PG試験1件で認証後のJWKS URL変更がデータ取得前に拒否されることを確認した。
既存privacy8件とconnector契約7件を含め48件成功。Workers環境58件、型チェック・lint・Nodeビルドとgit diff --checkも成功した。
schema/migrationと本番設定・データは変更していない。
未完了: D1でのprivacy catalog/context/users/export/erase、非direct content upload、大きなmanifest対応、
他の未移植機能、実データ移行・実サービス性能/品質/費用検証・本番切替。

## 続行実装: D1 Privacyの読み取り・エクスポート

非公開のD1PrivacyReaderを追加し、catalog/contexts/users/exportを実装した。
消去adapterと共通の契約検証が揃うまでは公開privacy routeへ接続せず、PostgreSQLの既存経路を維持する。
この変更だけでクラウドprivacy endpoint全体が利用可能になったとは扱わない。

owner/installation/issuer/client/deployment/JWKS snapshotとlegacy historyのupgrade条件を、各read batch内で再検証する。
接続active、ban、quotaとは独立した回復権限を維持する。個人別・講座別のQ&A author hashは共有のsubject契約から計算する。
所有講座一覧を準備時とbatchで比較し、新講座が増えた場合はauthor hashを再計算する。crypto同時実行数を100以下に抑える。
対象のlog/evaluation/conversation/turn/Q&A/vote/moderation/操作監査/report/historyを所有者・subject・contextで絞り、peerや認証credentialを出力しない。
context mappingを失ったデータは@orphanとして回復する。

context集合のUNIONは実D1互換の実行環境でcompound SELECT制限に当たったため、collectionごとの101件候補をJSON経由で統合する形へ変更した。
各collectionでcursor後の先頭101候補を採るので、全体の先頭100件とnext cursorを欠落なく構成できる。
exportは既存PGと同じUnicode code point単位で65536文字ずつ返し、record hashで途中変更/削除を拒否する。
D1の型付きcheckpoint/metadata/write BLOBはbase64とtype/encodingを出力し、内容を切り捨てない。
別checkpoint_blobs tableは存在せず、channel値はcheckpoint BLOB内に含まれるため同collectionは空とする。
conversationは公開UUIDがscope間で再利用されても欠落しないようthread IDをopaque export record IDに使う。
PostgreSQLのconversation_id依存cursorにも同等の重複ID検証と互換性対応が必要であり、公開切替前の継続項目とする。

検証: 実migrationを適用したworkerd D1 fixtureの13件が成功。
全保存collectionとbinary metadata/write、認証情報/peerの除外、catalog/context/users、orphan、Unicode分割と変更/削除拒否、
cursor検証、inactive回復、JWKS/legacy変更、準備中の講座追加、context pagination、公開UUID再利用を確認した。
型チェック・lint・Nodeビルドとgit diff --checkが成功。Workers既存回帰58件も成功した。
remote D1での性能・費用検証ではなく、D1 privacy readコードを公開Workerで通したE2E検証もまだ行っていない。
schema/migrationと本番設定・データは変更していない。
未完了: D1 privacy erase、PG/D1共通privacy契約と公開route接続、上記cursor互換性、非direct content upload、大きなmanifest対応、
他機能の移植、実データ移行・実サービス性能/品質/費用検証・本番切替。

## 続行実装: Privacy消去と二環境の公開ルート接続

D1PrivacyEraserを実装し、PrivacyRepository factoryを経由してcatalog/contexts/users/export/eraseを公開Honoルートへ接続した。
前節までの「D1 privacyは未接続」の状態はこの実装で解消した。本番設定のprivacy有効化やDB切替を実施したという意味ではない。
認可・upgrade判定・所有講座snapshotとauthor hashの準備をprivacy-scopeへ分離し、読み取りと消去で共有する。

消去は一つのD1 batchでsession失効、feedback/history削除、会話とcheckpoint/turnのCASCADE削除、log/evaluation削除、
本人のQ&A/reply匿名化、本人のvote削除/moderator匿名化、操作監査/reportアクセス記録削除を確定する。
共有教材・講座・他actorのデータは保持する。nativeのstarted markerは古いsessionの復活を防ぐため維持する。
feedbackのboolean log IDを整数1へ変換して削除することはしない。
material/tag操作UUIDのhashを削除前に準備し、その操作集合が確定時にも一致することを検証する。
途中で監査記録が増えた場合は新しい集合から再試行し、barrierを持たない削除を防ぐ。
登録/JWKS/legacy状態が変われば拒否する。late stepが失敗した場合、session/model memory/本文/新しいbarrierもすべてrollbackする。
削除件数は各文直後のchanges()で数え、CASCADEされた子行を親の件数へ混ぜない。

両DBのconversation export record IDをthread:付きのthread IDへ変更し、同じ公開conversation UUIDを持つ複数scopeの会話も列挙する。
旧UUID形式のcursorは409でexport再開始を求め、別threadを黙って飛ばさない。
PostgreSQL checkpoint exportには従来欠けていたmetadataも含め、D1のbinary metadataと同様に本人のmodel dataを回復可能にした。
両DBのschema/migrationは変更していない。

検証: 同一seedと共通7契約をD1/PostgreSQLで実行し14件成功。
全保存collection、Unicode継続、UUID再利用/旧cursor、失効後のhistory/session復活拒否、late failureのrollback、inactive回復、
実RS256署名付きの公開Hono routeとassertion replay拒否を両DBで確認した（JWKSのHTTPだけテスト応答へ置換）。
PG fixtureは実Drizzle schemaと公式PostgresSaver setupを使用し、memory FKのCASCADEも検証した。
D1固有read13件/erase7件ではorphan/peer/metadata分離、binary保存内容、永久barrier、他context、確定直前の新規操作/JWKS/legacy変更も確認した。
既存privacy8件、retention9件、report15件を含め66件成功。Workers回帰58件、型チェック・lint・Nodeビルドとgit diff --checkも成功した。
検証用PGはsynchronous_commit=off。実D1/Vectorizeの性能・容量・費用検証や公開Workerへのremote E2E試験ではない。
本番設定・データは未変更。非direct content upload、大きなmanifest対応、他の未移植機能、実データ移行・実サービス検証・本番切替は継続対象。

### LMS非direct content upload・確定の二環境化

非direct転送をDBトランザクションから分離し、リクエスト固有キーへ保存してからD1/PostgreSQLの業務契約で採用する。
所有者・installation・resource世代・有効状態・元ファイル・サイズ・形式と期限付きclaimを採用/確定時に再検証する。
転送中の世代変更、期限切れの旧転送、重複confirmは現行ファイルやジョブを変更しない。
HEADでサイズを確認できない場合はuploadingと利用枠を維持し、正しい再転送を可能にする。

保存前に遅延storage_cleanupを記録する。採用時はその対象を旧ファイルへ原子的に差し替え、失敗時は候補キーの即時回収も記録する。
回収タスクのbytes=0は物理ファイル回収専用で、論理的な利用枠を返却しない。遅延回収は遅れて完了する転送にも対応する。
PostgreSQLの採用とabandonは所有者→installationの同じロック順で直列化し、採用済み候補の削除タスク発行を防ぐ。
転送には10分の期限と呼出元キャンセル、予約サイズのストリーム上限を適用する。

共通契約12件を両DBで実行して24件成功。既存LMS同期59件も成功。
不正サイズ、転送中の世代変更、HEAD後の無効化、claim失効、採用失敗rollback、採用/abandon競合、実Hono経由の認証・確定、
実cleanup runnerによる不要ファイル回収と利用枠維持を検証した。Workers回帰59件はキャンセル付きFixedLengthStreamとローカルR2も含む。
型チェック・lint・Nodeビルドを検証。本番のD1/R2への接続や移行は行っていない。
大きなmanifestの継続処理、他の未移植機能、実データ移行・実サービスの容量/性能/検索品質評価、本番切替は継続対象。

### アカウント連携一覧・MCP台帳保持処理の二環境化

APIキー/OAuth同意の一覧をAccountIntegrationsRepositoryへ移し、D1とPostgreSQLのDrizzleアダプターで取得する。
共通処理にはDBのテーブル型を公開せず、表示用DTOだけを返す。秘密鍵hash、client secret、token、metadataはSELECTしない。
APIキーの所有者・許可profile、OAuth同意のuser_idによる絞り込みを維持する。
D1のJSON文字列scopesをstring[]へ変換し、日時をDateへ正規化する。NULL発行日時はPostgreSQLの既存DESC順と同じ先頭に置く。
共通7契約を両DBで実行して14件成功し、105件の取得、tRPC route、他ユーザー除外、日時/権限/表示名の正規化を確認した。
既存PostgreSQL連携テスト13件も成功した。認証APIの解除処理には変更していない。

日次maintenanceのMCP冪等性台帳削除をIdempotencyRetentionRepositoryへ移し、D1でPostgreSQL接続を不要にした。
期限判定と件数制限を含む単一DELETEで、複合主キー単位に削除する。期限が同じ場合の処理順も安定させる。
両DBの共通検証6件で、件数上限、保持期間変更、未来/直近データの保全、複合主キー、削除件数、入力検証を確認した。
既存maintenance/台帳migrationテスト17件、Workers回帰59件、型チェック・lint・Nodeビルドも成功した。
本番設定・DB・認証情報は未変更。招待、課金、管理、Q&Aなど残るDB直接依存と実データ移行/本番評価は継続対象。

### 課金Repository・Stripeイベントの二環境化

BillingRepositoryへ課金状態の取得、最初のStripe顧客の採用、イベントの照合/確定を集約した。
PostgreSQL版は従来のDrizzle transactionとtimestamp精度を維持する。共通サービスはDB具体型へ依存しない。
D1は条件付きイベントINSERTとユーザー更新を同一batchに含め、revisionが一致する場合だけ両方を確定する。
重複イベントは再更新せず、古いsnapshotは受領記録を残さずBillingStateChangedErrorを返し、既存サービスが再照会する。
更新の制約違反などでbatchが失敗すればイベント記録もrollbackする。StripeへのネットワークI/O中はDB transactionを保持しない。

D1 migration 0010はusers.billing_revisionと更新triggerを追加する。変更番号は同じtimestamp内の変更やABAも検知し、
JS Dateの精度に依存しないopaque文字列として共通契約へ返す。PostgreSQLのschema/履歴は変更していない。
利用枠は確定時のquota_sourceに従い、管理者指定値を上書きしない。使用量カウンターは変更しない。
顧客ID採用は原子的coalesceと有効ban条件で、一つの顧客IDを競合したcheckout双方へ返す。

共通課金契約8件を両DBで実行して16件成功し、D1固有の同時刻/ABA検証1件も成功した。
既存webhook/退会/redirectテスト66件、D1の実Hono webhook経由3件も成功した。
Stripe SDKの署名検証/照会はテスト応答へ置換し、D1はローカルworkerdで全migrationを適用している。
D1 routeでは元のbodyの引渡し、重複配送、管理者変更と競合した照会の再試行、Stripe照会失敗後の再配送を確認した。
Workers回帰59件、型チェック・lint・Drizzle D1履歴check・Nodeビルドを実施した。本番設定・Stripe・DBデータは未変更。
永続化全体の回帰実行では92ファイル767件中766件成功。追加したD1専用billing_revisionを既存schema-parityのadapter列として明示し、
同テストの再実行も成功した。業務列と外部キーの同値検証は継続する。
追加の異なるイベント同士の同一revision競合2件とD1 Hono route3件は個別再実行で成功した。

### 管理ユーザー一覧・利用枠/使用量・退会準備の二環境化

AdminUserRepositoryへ管理ユーザーのrole判定、一覧/詳細、利用枠設定、使用量補正、退会準備を移した。
PostgreSQLは既存Drizzle処理をadapterへ移し、D1にはSQLite Drizzle処理と原子的batchを追加した。
利用枠のplan復帰は現在のplan_code/subscription_statusに基づく一文の条件分岐で、事前readとの競合を避ける。
NULLによる無制限、0、partial/no-op、plan/admin設定、使用量のsafe integer範囲、補正対象userの分離を維持する。
usage_period_startの返却は両DBでUTC ISOへ正規化した。

D1の退会準備はban、session/access token/consentの削除、refresh token失効、account-deleteのoutboxを同じbatchで確定する。
管理者と存在しないuserには何も書かず、重複実行では永続化された同じjob IDを返す。
壊れた既存削除taskやoutbox書込失敗はbatch全体をrollbackし、ban/sessionだけを先に確定しない。
この変更は退会準備/ジョブ発行までであり、cloud削除Worker全体の検証完了を意味しない。

共通13契約を両DBで実行して26件成功。実tRPC経由のbackend選択と管理者権限、literal検索の%/_/backslash、ASCII大小文字、
ban期限、role token、plan復帰、使用量の日時/大きい数値、競合した退会準備、認証情報失効、late failureのrollbackを確認した。
既存管理テスト72件と合わせ98件成功。型チェック・lint・Nodeビルドも成功した。
D1 fixtureはローカルworkerdに全migrationを適用しており、本番DB・認証情報は変更していない。

継続対象: native権限/ban変更のBetter Auth処理はPostgreSQLの既存transactionを残しており、D1では未実装として明示的に拒否する。
cloudからPostgreSQLへ暗黙に接続しない。D1のLIKEはASCII以外の大小文字同一視がPostgreSQL ILIKEと異なるため、その検索互換性も継続対象。
招待、Q&A、大きなmanifest、cloud削除Workerの監査、実データ移行/性能/検索品質評価と本番切替も残る。

### 管理フラグ変更のD1対応

前節で未実装としていたnative権限/ban変更をAdminUserRepository.patchFlagsへ移した。
共有service/repositoryからDb型とtransaction callbackを除き、PostgreSQL固有の接続/Better Auth更新はadapter内へ閉じ込めた。
PostgreSQLは従来どおり対象行をlockし、同じtransaction内のBetter Auth ban/unban/setRoleを使用する。

D1は実Better Auth browser profileのuserHasPermissionとcookie cache無効のgetSessionで認証/権限を検証する。
その後、session ID/token/期限、actor ID、admin role token、ban有効期限を同じ原子的Drizzle batchで再照合する。
許可が残っている場合だけフラグ更新、ban時の対象session削除、更新済み管理DTO取得を行う。
banReason='No reason'、無期限ban、unban時のreason/expiry解除、roleのadmin/user化は現行Better Auth設定に揃える。
自己ban/管理者権限解除を拒否し、unbanは削除済みsessionを復元しない。
D1のSQL例外は照合用session tokenを含む可能性があるため、batch失敗は秘密値やcauseを含まない例外へ変換する。

共通8契約をD1/PostgreSQLで実行して16件成功。実Better Auth credential loginのcookieを使い、
フラグの複合変更、ban/unban、セッション失効、無認証/非admin拒否、自己保護、対象不在、更新/削除失敗rollback、
実tRPC経由の変更を確認した。D1固有5件では確定直前のsession削除/期限切れ/role剥奪/banとtokenのログ非露出を検証した。
既存native flags/管理route/管理repositoryテストを合わせ91件が成功（追加のtoken非露出1件は共通契約suiteで再実行）。
Workers回帰59件、型チェック・lint・Nodeビルド・git diff --checkも成功した。本番設定・DB・認証情報は未変更。
Unicode検索互換性、招待、Q&A、大きなmanifest、cloud削除Workerの監査、実データ移行/性能/検索品質評価、本番切替は継続対象。

### クラウド削除Workerの内部API接続

delete_account_dataのクラウド経路を専用の軽量Pythonタスクへ分岐した。
registryはD1設定時に旧PostgreSQL/メディア処理moduleを読み込まず、Lambda dispatcherからjob IDとclaim済みlease tokenを渡す。
Pythonは署名付きheartbeatとaccount-delete/stepを繰り返し、500段階の予算や通信失敗時は既存ジョブ再配送で残りの行から再開する。
オンプレミスと明示的cloud PostgreSQL rollbackは従来の直接接続タスクを維持する。内部削除API側はD1専用で、暗黙のPG fallbackを設けない。

D1は生きたjob lease/type、対象ユーザーと一致する永続account-delete outbox、無期限ban、非adminを照合する。
1段階で動画1件を既存VideoMutationRepositoryの削除へ渡し、そのreceipt生成時にも同じ認可を再照合するadapter内部のfenceを追加した。
動画の物理キー/マルチパートと現行/段階登録済みベクトルは、ポインター削除と同時に回収taskへ記録する。
動画がなくなった後、NO ACTIONのchat_logs/course_evaluation_snapshots/video_courses/tags、APIキー、LTI資格情報を100件ずつ処理する。
対象レコードがすべてなくなった場合だけユーザーを削除し、native auth/会話/モデル記憶は既存FKのCASCADEで削除する。
business dataの削除とroot削除は同一batchなので、root制約違反時はその段階の削除をすべてrollbackする。
root不在の再配送は同じ永続job grantを照合してcompletedを返す。leaseやban/roleの変更があれば新しい削除を拒否する。

D1削除14件と既存動画/内部API16件で30件成功。対象分離、105件のtags/APIキーの継続、現行vector/storage outbox、
NO ACTION所有行、native認証/会話/checkpoint削除、無効grant7種、snapshot後のban変更、video/rootのlate failure、
再配送、実Honoの署名付き操作を確認した。Python関連51件と実PostgreSQL削除11件も成功し、onprem経路を維持した。
Workers回帰59件、型チェック・lint・Nodeビルド・git diff --checkも成功した。本番設定・DB・R2・Vectorizeは未変更。

物理オブジェクトの回収はAPIメンテナンスが再試行するため、SQSジョブcompletedは物理回収完了を意味しない。
登録されていない過去のR2/Vectorizeオブジェクトの照合、大量関連行のCASCADE、実R2/Vectorize障害やremote負荷試験は未検証。
Unicode検索互換性、招待、Q&A、大きなmanifest、移行ツール/本番切替も引き続き必要。

### 招待配送/回復・プレビュー/参加者一覧の二環境化

InvitationDeliveryRepositoryへ配送token hashの回転、配送結果/タスク完了の確定、配送taskを失ったqueued招待の回復を移した。
PostgreSQL版は従来のrow lock/transactionを維持する。D1はbatch先頭で有効なtask ID/attempt/5分leaseをreceiptへ捕捉し、
後続の書込をそのreceiptで保護する。期限切れ/再claim済みの旧attemptは回転・成功/失敗の記録・task完了を行わない。
配送結果の配列はD1でJSON CTEから一括更新する。同一招待への複数結果も入力順の最終状態、実際にsentとなった最終日時、
試行回数を維持し、100件の結果でもstatement数を増やさない。配送結果とtask完了が一緒にrollbackすることを検証した。

InvitationReadRepositoryへhashによるpreviewとowner向けparticipantsを移した。
D1のparticipantsは所有権確認と招待/参加者取得を同じbatchへ含め、peerはnotFoundとする。
日時はUTC ISOへ正規化し、参加者表示のexpiredはDBのpending状態を変更しない。
previewとtoken回転はmanaged_by_lms/native_access_disabled、およびLMS動画を含む旧native courseを拒否する。
ownerによる管理用participants閲覧は従来どおり認める。

共通15契約を両DBで実行して30件成功。lease/状態/期限/LMS scope、100件の配送結果、空結果とtask完了、
stranded回復、late completion failureのrollback、所有者分離、preview/日時を確認した。
D1固有2件は実delivery orchestratorとprovider mockを使用し、本文の平文tokenを保存せずhashだけを保持すること、
送信失敗後の再claimでtokenを作り直し、送信結果を確定することを確認した。
既存配送/maintenance/招待serviceテスト41件と合わせ73件、Workers回帰59件が成功した。
型チェック・lint・Nodeビルド・git diff --checkも成功。本番のDBやメール送信、外部設定は変更していない。

招待機能全体のD1化はまだ完了していない。作成とOutbox発行、承諾/辞退、ownerによる再送/取消、member削除/脱退は継続対象。
同時再送task間の配送順序や実メールプロバイダ障害、本番相当の容量/性能も移行完了の検証対象として残る。
Unicode検索互換性、Q&A、大きなmanifest、実データ移行と本番切替も引き続き必要。

### 招待の承諾/辞退・再送/取消・membership削除の二環境化

InvitationWriteRepositoryへ受信者のdecide、ownerのcontrol、remove/leaveを移し、PostgreSQLの具体的なtransactionと型はadapter内へ分離した。
作成と再送が共有するPG outbox primitiveもPostgreSQL用ファイルへ移した。
PGのowner controlはcourse→invitationのlock順を明示し、作成/承諾と揃える。

D1の受信者判定はbatch内で現在のtoken/status/expiry/確認済みemailを照合し、membership挿入とinvitation確定を一緒に行う。
メールのUnicode/trim正規化には共通JS関数を使い、その元となるusers.email/email_verifiedが変更された場合はsnapshotを再取得する。
receiptにはバッチ内で決めた結果だけを保存し、commit前に削除する。expiryの確定、失敗結果、成功結果も同じ判定点から返す。
acceptedの同一受信者によるreplayは成功を返すが、削除/脱退済みmembershipを再作成しない。
受入前とreplayの両方で現在のnative course権限を確認し、Moodle化したcourseへの旧リンクによる復活を拒否する。
辞退は既存PG契約を維持し、権限付与を行わずpendingのemail/expiry判定だけを適用する。

再送はtoken hash/expiry/queuedの更新と配送outboxを一つのbatchで確定し、取消はownerの現在の所有権で保護する。
期限切れ/terminal状態は再送で復活させない。D1 cloudは配送taskを作り、onprem PGは従来どおりメール配送を行わない。
ownerのmember削除と本人のleaveは条件付きDELETEで、別owner/別memberに作用しない。

共通23契約を両DBで実行して46件成功。D1固有3件でsnapshot後のemail変更、検証解除、Moodle化を拒否した。
検証内容は確認済みemailのUnicode/trim正規化、terminal/期限、並行accept/decline、並行accept/revoke、同一受信者の並行accept、
membership削除後のreplay、resend/取消、member削除/leave、membership後の確定失敗rollback、outbox失敗rollbackを含む。
実tRPCのplaintext tokenからの承諾も両DBで確認し、tokenを永続化しないことを検証した。
既存配送/権限/Moodle course/onprem lifecycle/招待route/serviceを含め108件が成功（競合追加分は共通suiteを再実行）。
Workers回帰59件、型チェック・lint・Nodeビルド・git diff --checkも成功。本番DB・メール・設定は未変更。

招待機能で残るPG直接依存はcreatePendingCourseInvitationsの作成/一括outbox発行である。
一括作成と新規IDに対応するoutboxの原子性、recipient上限、重複/既存member判定をD1へ移植し、招待全体のE2Eで検証する必要がある。
同時再送task間の配送順序、Unicode検索互換性、Q&A、大きなmanifest、実データ移行・本番性能/検索品質評価と切替も継続対象。

### 招待の一括作成・Outbox発行の二環境化

InvitationCreateRepositoryへcreatePendingCourseInvitationsを移し、公開facadeから最後のPG具体型/SQL依存を除いた。
PostgreSQLは既存transaction/owner lockを維持する。両実装は100宛先の上限とDate入力を共通検証する。
既存memberのメール照合を共通JSのtrim/Unicode lowercaseへ揃え、古い非正規化メールでも二重招待しないようにした。

D1はcourse ownerのメールとmember ID/emailの順序付きJSON snapshotを取得して正規化し、batchのreceipt生成時に再照合する。
途中でowner email/member/現在のnative course権限が変われば書込を行わず再取得する。
期限切れpendingの更新、JSONからの一括INSERT、新規行だけに対する配送taskのINSERT、返却行取得、marker/receipt削除を同じbatchで行う。
宛先数に応じてSQL文数を増やさず、作成はsnapshot取得と8文のbatchで実行する。
新規行の識別にはD1専用nullable creation_nonceを使い、commit前にNULLへ戻す。
0011 migrationが列を追加し、0012が非NULLだけのpartial indexを追加する。PG schema/historyは変更していない。
既存pending、同一宛先の重複、unique token hash衝突による非作成行には新しい配送taskを作らない。
onpremは引き続きmail taskを作らず、サービスが手動共有URLを返す。

共通12契約を両DBで実行して24件成功し、D1固有3件でmember/owner email/courseのsnapshot変更を検証した。
100件一括作成、重複・既存member・owner除外、Unicode/空白のメール、期限切れ履歴、並行作成、権限拒否、空入力、
outbox失敗時のexpiry/INSERT rollback、marker非残存を確認した。
cloudの作成→claim→実配送orchestrator(provider mock)→preview→承諾と、onpremの手動URL→preview→承諾も確認した。
招待作成/権限/ルート/onprem lifecycleの関連55件、Workers回帰59件が成功。
永続化全体99ファイル939件の実行では938件成功、既存scene-index-writerの1件が5秒timeoutだった。
同じtimeout設定で同suiteを単独再実行し9件成功した。テストのtimeout値は変更していない。
型チェック・lint・Drizzle D1履歴check・Nodeビルド・git diff --checkも成功。本番DB・設定・メールは未変更。

member snapshotはcourseのmemberメール全体を読むため、大規模courseでのmemory/容量/レイテンシは本番相当データで評価する必要がある。
同時再送taskの配送順序と実プロバイダ障害のremote検証も継続対象。
追加棚卸しで通常動画のmultipart-upload-repositoryがまだPG transactionへ依存することを確認した（R2単体のWorkersテストはDB移植の証拠ではない）。
multipart upload、Q&A、Unicode検索互換性、大きなmanifest、移行ツール/実データ検証・本番切替を引き続き実装・検証する。

### 通常動画のmultipart uploadの二環境化

MultipartUploadRepositoryへ初期化・part URL発行・完了・ファイル参照確認を分離した。
PostgreSQLは既存のtransaction/row lockをadapter内に維持し、D1はstorage I/Oの前後をsnapshot付き条件更新とbatchで確定する。
初期化競合の敗者はabort専用Outboxへ記録し、採用済みsessionを中断しない。
完了時は動画のpending更新と処理job作成を原子的に行い、重複完了でjobを増やさない。
PGの初期化commit応答喪失は現在のsessionを再照合し、両DBでstorage完了応答喪失後のHEAD照合により再開できる。

完了前に安定したdedupe keyの遅延回収taskを保存し、動画削除後に到着したstorage完了を回収対象にする。
uploading中はleaseを検証して2時間延期し、確定済み動画が参照するfileは保持する。
延期でもattemptを戻さず、古いleaseによる更新を拒否する。回収では既存の利用量精算を二重適用しない。
abort専用multipart_abortと孤立file回収multipart_cleanupは通常のstorage_cleanupと別種別にし、旧消費側がファイル削除と誤解釈しないようにした。
PG0062とD1 0013–0016でkind制約を拡張する。
D1のテーブル再構築は完了済みsentinelで過去のAUTOINCREMENT high-water markを引き継ぎ、コピー後にsentinelを削除する。
Drizzleの再構築時の式index引用問題を避け、式indexの復元は別の生成migrationに分けた。
既存のSQL/snapshot/journalは手編集していない。sentinel挿入/削除は生成したcustom data migrationである。

実際のローカルR2 bindingが返すopaque ETagに対応し、frontend/tRPC/両adapterの検証を共通化した。
ETagは長さを制限した引用符・空白・制御文字以外のASCIIとして扱い、S3 XMLではentity escapeする。
ローカルD1+R2の実multipart session/part保存/完了/GC、両DBでの競合・応答喪失・rollback・重複完了、
削除後の遅延完了、既存taskの値と削除済み高位IDを含むsequence保持を検証した。

これは本番R2/S3やブラウザ経由の障害試験を完了した証拠ではない。
storage初期化の応答を失いupload ID自体を取得できなかったsessionの回収には、実bucketの未完了multipart lifecycle設定の確認が必要である。
長時間のremote障害、延期を繰り返したtaskの再試行上限、登録されない孤立objectの照合は運用検証に残る。
Q&AのPG直接依存、Unicode検索互換性、大きなmanifest、移行ツール・実データ照合・性能/検索品質評価と本番切替も継続対象。
本番DB・storage・設定は変更していない。

追加の参照付き移行試験で、D1のDROP時にlti_material_operations.external_task_idがON DELETE SET NULLで消えることを再現した。
0013は参照を1操作1件の完了済みtaskとして退避し、0016で復元後に退避taskを削除する。
単一の巨大JSONに集約しない。migration中はアプリ/maintenanceの書込を停止し、0013–0016を連続して適用する必要がある。
元taskの全列、LMS操作履歴の全列、過去の高位IDを削除した後の採番、index、新kind受入/不正kind拒否を実D1 bindingで確認した。
永続化層全体102ファイル973件が成功し、この追加参照保持修正後は移行テスト2件を再実行して成功した。
最終修正後のmultipart adapter/R2 28件とWorkers回帰59件も成功した。
frontend multipart/API clientの48件、API型チェック・lint・Nodeビルド、両Drizzle履歴check・PG provenance検査・git diff --checkも成功。
検証用に起動したPostgreSQL containerはテスト終了後に削除した。

### コースQ&Aの二環境化

QaRepositoryを定義し、features/qa/coreはfactoryを呼ぶ共通facadeへ変更した。
PostgreSQLの既存SQLとcourse/question/reply/sessionのtransaction lockはPostgreSQL adapter内へ移した。
D1 adapterは一覧・詳細・質問/返信の作成/編集/削除・投票・featured変更を実装する。
認可は現在のcourse owner、membership、公開share slug、native_access_disabled/managed_by_lmsと保護動画を照合する。
LMS actorはnative userと別のpseudonymとして扱い、現在のcourse所属動画とownerが一致する範囲だけを公開する。
source_video_idも検証するため、元動画の削除やcourseからの除外で制限付き投稿がcourse全体へ公開されない。
空の動画scopeはcourse全体向け投稿のみを扱い、最大1000動画はJSON bindで渡す。

D1の変更はbatchの最初にsession/認可/対象の存在/操作権限を判定し、その結果を一時receiptで後続SQLへ渡す。
投稿・親質問の更新・moderation audit・receipt削除を同じbatchで確定する。
監査や親更新の失敗で全体をrollbackし、拒否結果でもreceiptを残さない。
同時feature指定は状態が変わった場合だけauditを記録し、同じactorの投票は一意制約で冪等にする。
LMS session proofがある場合は、ownerと現在の保存session・expiry・registration/subjectをbatch内で再検証する。
両DBとも公開DTOの日時/booleanを正規化し、author emailや内部identifierを返さない。

ASCII大小文字を含むliteral検索・動画/unanswered絞込・件数・ページングを共通契約で確認する。
SQLite lowerとPostgreSQL lowerのUnicode互換性は未解決であり、本番切替前に正規化検索設計と既存データの移行が必要である。
remote D1の容量/同時実行性能、実LMS権限変更を含むbrowser E2Eは別途検証対象。
この変更で本番DBや設定は変更していない。

共通22契約を両DBで実行し44件成功、D1固有4件のbatch直前失効/rollback試験と合わせ48件成功した。
共通契約には実Better Auth Cookie→tRPC投稿→匿名share詳細閲覧→session削除後の投稿拒否、最大1000動画scope、literal検索を含む。
既存PostgreSQLの未変更DDLを用いるQ&A回帰17件、Workers回帰59件も成功した。
型チェック・lint・Nodeビルド・git diff --checkは成功。LTI browser suiteの2件は有効化しておらず、browser検証完了とは扱わない。
検証用PostgreSQL containerはテスト終了後に削除した。

### 管理者ユーザー検索のUnicode互換性

D1の管理者一覧はSQLite LIKEに依存していたため、Üなどの非ASCII大文字小文字でPostgreSQLと結果が異なった。
両adapterで共通のliteralSearchPageを使い、JSのlocale-independent toLowerCaseとliteral includesに揃えた。
検索対象はusernameとemailであり、メールの本人性判定や認可にはこの検索用正規化を使用しない。
accent除去・互換文字正規化・Unicode full case foldingは行わない（ßとssなどを同一視しない）。
名前/メール/idだけを200件ずつprimary-key cursorで走査し、検索に一致した件数を数えてからoffset/limitを適用する。
全一致行をmemoryへ蓄積せず、最後に当該ページの最大100 IDsに対するquota等の公開projectionを取得する。
空検索はSQLのcountと通常ページ取得を維持する。
PostgreSQLも同じ検索関数へ揃え、OS/DB localeとSQLiteの組込case conversionの差に依存しないようにした。

両DBの関連契約30件が成功。Unicodeの名前/メール、literal記号、SQL注入風の検索語、405ユーザーを跨ぐ件数/ページ末尾/範囲外offsetを確認した。
検索は候補全体の走査を要する。メモリ量を制限したことはスキャン件数・料金・応答時間の改善の証拠ではなく、
大規模データの性能評価と維持可能な正規化検索projectionの検討は継続対象である。
複数ページ走査中の同時更新に対するsnapshot isolationは導入していない。
Q&A検索のUnicode対応、動画一覧とPostgreSQL localeの厳密な検索契約整合、実データ移行/本番性能/検索品質評価も残る。
本番DB・設定・認証情報は変更していない。
最終修正後も両DBの契約30件が成功し、既存PostgreSQL literal検索と管理者API回帰41件も成功した。
検索cursorが進まないadapter応答はエラーとして停止し、既存APIモックもcursor終端を返す形へ更新した。
型チェック・lint・Nodeビルド・git diff --checkが成功。検証用PostgreSQL containerは終了後に削除した。

### 本番移行前のベースライン・設定検査ツール

scripts/d1-baseline.tsとdb:d1:baselineを追加した。既存のDATABASE_URLを読み、REPEATABLE READ / READ ONLY内で
テーブル別件数/物理容量/列型、実pgvector次元別件数、bigint範囲と安全整数範囲外件数を記録する。
768/1536以外の次元とunsafe bigintをconversion_findingsへ列挙する。ベクトル本体や認証/ユーザー本文は出力しない。
ウォームSELECT 1のround-trip p50/p95/p99は収集するが、接続確立・コールド起動・Workers API E2Eの指標とは区別する。
JSONは0600の一時fileへ書き、同一filesystem内のhard linkで既存fileを上書きせずに公開する。
失敗した収集はrollbackし、途中fileを片付ける。sourceへのDDL/DMLは行わない。

scripts/d1-cutover-check.tsとdb:d1:cutover-checkはnamed environmentのJSONCを読み、cloud/D1選択、DB bindingと独立migration履歴、
768/1536別Vectorize index、workers.dev閉鎖、rollback override、plaintext secret混入を検査する。
rootから非継承のbindingを補完しない。configuration_validはローカル設定の判定に限り、remoteのindex設定・secret・履歴・データ・性能/費用を保証しない。
現在のwrangler.jsonc productionは明示的cloud editionとD1/Vectorize bindingがなく、チェックが失敗することを確認した。
本番設定は変更していない。実本番ベースライン、remoteリソース作成/照合・移行は未実施。

実PG integration 5件と設定検査14件、合計19件が成功。
同時書込があってもcountが同じsnapshotを使うこと、可変vectorの768/1536/NULLと未対応1024の識別、bigint値の文字列保持、
CLIログにrow内容/DSNを出さないこと、file mode/非上書き/失敗file除去を確認した。
新規運用scriptをtsconfig.d1-tools.jsonで型検査し、API typecheckの既存CI経路から実行するようにした。
手順と未達の本番gateはdocs/operations/d1-migration-preflight.mdに記載した。

### 移行対応表と型変換primitive

最新Drizzle journal/snapshotから移行対応表を生成するdb:d1:manifest / db:d1:manifest:checkを追加した。
共通55テーブルの全列に変換方針があり、PG専用2Embedding表、D1専用10表、追加4列と別schema chat_memoryを専用処理として明示する。
新規/未対応source・target表/列、未対応型、未知の依存/cycleはmapping不完全として検出する。
D1のFK順序から挿入順を生成する。API CIにはmapping coverageの検査を追加した。
mapping_completeとexecution_completeは分離し、専用処理を列挙しただけでmigration完了としない。

型変換はPostgreSQL text projectionを前提とし、bigint安全範囲・有限REAL・UUID・boolean・date・offset付きUTC日時・JSON・text配列を扱う。
arrayはSQL to_jsonを使い、JSONはraw textを維持して大きな数値の丸めを防ぐ。SQL NULLとJSON nullも区別する。
opaque文字列はそのまま保持し、変換エラーは元の値を含めない。
日時のmicrosecondは既存JS Date契約に揃えてmillisecondへ切り詰める。この正規化は移行照合でも適用する必要がある。

実PG→変換→実workerd D1 bindingの試験で、safe bigint最大値、JSONの非safe整数lexeme、UTC日時、閏日、bool、Unicode/NULL/quote/comma付き配列、opaque文字列を確認した。
unsafe bigintの再取得は投入前に拒否し、D1の既存値を変えないことを確認した。
専用Embedding/visual/checkpoint変換、実データexport/import/照合、remote資源と性能/検索品質のgateは未完了。本番DB・設定は変更していない。
最終検証はmapping/型変換35件と実PG→D1 1件、計36件が成功した。
API/運用scriptの型チェック、lint、manifest coverage check、git diff --checkも成功。検証用PG containerは終了後に削除した。

### private snapshot archive export

db:d1:export / scripts/d1-export.tsを追加し、最新の移行manifestからlive schemaを照合した上でsourceをexportする。
単一READ ONLY / REPEATABLE READ snapshot内で、table cursorから一定件数ずつprivate NDJSONへ書く。
共通55表は型変換、PG専用Embedding表とchat_memoryはraw-specialとして保持し、byteaはhexで保持する。
共通表の追加/欠落/型変更、未知の表、不完全なauxiliary schema、unsafe値は公開前に拒否する。
source sequence状態と存在するDrizzle履歴も含める。sequenceはMVCC外の観測なので、最終cutoverにはwriter停止/drainが必要である。

table frameはencoding/PK/件数/row hashを持ち、最終frameは全体hashとexecution_complete=falseを持つ。
0600の一時fileへ書き、source COMMIT・fsync後にhard linkで非上書き公開する。未公開の途中fileは除去する。
archiveは認証情報を含むためprivateに保管し、ログには件数だけを出す。suffixを固定し.gitignoreへ登録した。
形式変換だけで失われないよう、TimeZone/DateStyle/float精度もtransaction localで固定する。

実PGの全57表を現行Drizzle schemaから作り、認証rowを含めCLI exportの成功と秘密値非ログを確認した。
小さなschemaでsnapshot競合・cursor分割・sequence high-water mark・hash・bytea・rollback/途中file除去・非上書きを検証し、
変換済みarchive rowから実D1への保存も確認した。
これは全57表の本番データ移行や復旧成功の証拠ではない。専用データ変換、archive検証/import、D1のsequence/FK照合、remote検証は未完了。
本番DB・設定は変更していない。
最終検証はexport integration 10件、mapping/変換35件、baseline 5件の計50件が成功。
API/運用script型チェック、lint、manifest coverage check、git diff --checkも成功。検証用PG containerは終了後に削除した。

### archiveの事前検証

db:d1:verify-archiveとstreaming verifierを追加した。export形式をversion 2へ更新しsource_schemaを明示する。
headerのmanifest hashとsource/auxiliary inventoryから全tableの存在を検証し、重複/未知表、列encoding、値型・NULL・safe integer・日付正規化を検証する。
各tableと全体のhash、行数、footerの明細を照合し、途中切れ・不正UTF-8・非正規JSON/重複key・余分な末尾frameを拒否する。
private regular fileだけを読み、1行のmemory上限を設定する。エラーは固定文言で、元の値を含めない。
検証はDB接続も書込も行わず、verifiedとexecution_completeを区別する。旧形式は拒否し再exportが必要である。

実PGの現行全57表のexport→検証CLIを接続し、認証rowを含むarchiveの成功と破損後の拒否・秘密値非ログを確認した。
専用byteaを含むauxiliary archiveも実exportとverifierを接続した。
純粋な破損試験ではhashを再計算してもunsafe型・列変更・table欠落/重複・inventory不一致を拒否することを検証した。
27件（verifier 17件、export integration 10件）が成功。API/運用script型チェック・lint・manifest coverage check・git diff --checkも成功。
一括import、専用データ再構築、FK/sequenceと値の照合、remote資源/性能/検索品質/復旧演習は継続対象。本番DB・設定は変更していない。

### 共通55テーブルのoffline D1 importエンジン

importCommonTablesを追加した。privateな作業コピーを全件検証し、共通rowを表別private spoolへ分離した後、D1のFK順に投入する。
元のarchiveの並びはPG表名順でもよく、全体memory読込や全fileの表数分再走査を避ける。
新規targetは全application tableが空であることをbatchで確認し、表/共通列の型・NULL定義も照合する。
D1専用migration 0017はmigration_importsの進捗/入力hashを保持する。schemaからDDLを生成し、PG履歴は変更しない。
manifestのD1専用表は11表となり、進捗台帳の初期化方針を明示した。

D1 batchは期待checkpointを検証し、各rowをINSERT ON CONFLICT DO NOTHING後に全source列の値一致を検査し、進捗を一緒に更新する。
別archive/mappingの混在を拒否し、応答を失ってもcommit済みcheckpointから再開する。
全common表の件数/値とFKを最後に照合する。完了済みmarkerも再検証し、改変済みtargetを成功と扱わない。
元fileが検証後に変わってもprivate copy/spoolを使い、DBエラーに値が含まれていても固定の診断へ置換する。

実PGの現行schemaから認証・動画・course・question/replyとEmbedding rowをexportして実workerd D1へ接続し、
共通データとFKを保持して取り込むこと、Embeddingを未処理件数として明示しscenesへ偽装投入しないことを確認した。
専用データ/sequence復元とremoteのtarget選択CLIは未実装で、common_importedはcutover readyを意味しない。
offlineStagingは運用前提であり、公開routeを止める機能ではない。本番DB・設定は変更していない。

共通importの統合試験は、commit応答喪失、batch rollback、再開、非空target拒否、別archive混在、target列差分、元fileの後変更、並行import競合、完了後の値改変検出を含む。
さらに実PG Better Authでsignin→Cookie発行→export→D1 importを行い、cookie cache無効のDB session照会で元session IDを維持し、同じcredentialでD1 signinも成功した。
全schema/全APIの本番認証互換性とは区別する。

既定並列数での永続化全体実行は1115件成功/2件timeoutと、privacy PG fixtureの強制DROPによる57P01を検出した。
fixtureのDROPからFORCEを除き、pool終了直後のsocketを強制切断しないようにした。timeout値は変更していない。
CIと同じmaxWorkers=2で、該当suiteと共通importの45件を再実行して成功した。
最終的にCI条件（maxWorkers=2）で永続化層110ファイル1118件すべてが成功し、未処理例外もなかった。
API/運用scriptの型チェック・lint・Node build・D1履歴check・manifest coverage check・git diff --checkも成功した。
検証用PostgreSQL containerは全テスト終了後に削除した。

### 標準bigint sequenceの復元

archive version 3にsequenceの所有schema/表/列、increment/min/max/cache/cycleを追加した。
所有先はpg_dependから取得し、sequence名の命名規則には依存しない。旧version 1/2は拒否し、新archive/新stagingが必要となる。
標準の非cycle bigint identityだけを対象にし、未知/曖昧な所有先・独自設定・安全な次IDがないsource/target状態は、target行投入前に拒否する。

common row/FK照合後にsqlite_sequenceを復元する。is_calledを考慮したsource floor、target既存counter、取込済み最大IDの最大を保つ。
仮の業務rowを作らず、counterを下げない。SQL bindが内部表でREALになるケースを確認し、SQL内のCAST AS INTEGERでstorage typeを固定した。
型・重複・値のguardと更新はcounter単位で同じbatchに置く。応答喪失後も同じarchiveから単調に再適用できる。
この段階を終えた場合のみpending_sequence_restore=falseとsequences_restoredを返す。専用データ未処理のためexecution_complete=falseを維持する。

メタデータ/値照合の独立readとcounter単位の処理を25文以下のbatchへ集約し、DB往復回数を減らした。
counter単位の5文は分断せず、atomicityを維持する。test timeoutは変更していない。

実PG→archive→workerd D1で、実際に削除した高位ID、is_called=false、cacheの未使用割当、改名したsequence、既に高いtarget counter、復元commit応答喪失、
sourceの独自設定/未所有/unsafe状態、targetの重複/非integer/unsafe counter、AUTOINCREMENT欠落を検証する。
復元後の実INSERTが返すIDで非再利用を確認する。counter更新中にアプリの業務rowを増減させない。
本番・remote D1のsequence権限/動作・復旧リハーサルは未実施であり、本番DB/設定は変更していない。
最終検証は共通import/採番25件、純粋な採番方針16件、export 10件、archive verifier 17件の計68件が成功した（maxWorkers=2、timeout値未変更）。
型チェック・lint・manifest coverage check・git diff --checkも成功。検証用PostgreSQL containerは全テスト終了後に削除した。


### LangGraph履歴のoffline変換・D1再開

共通importの後段にcheckpoint専用フェーズを追加した。PGのcheckpoint/blob/write/migration履歴をprivate SQLite scratchへspoolし、公式JsonPlusSerializerでD1のwhole-checkpoint形式に再構築する。sourceは変更しない。
namespace/parent/metadata/pending write/task_pathを保持し、会話所有権・committed root・既知migration/codec・欠損blob・行サイズをtarget書込前に検証する。JSONBの数値versionは字句表現でblobを参照する。Bufferの再serializeによるbytes変形を避けるためUint8Arrayへ正規化する。参照されないblobは件数を報告し、原本archiveに保持する。

進捗は既存のmigration_importsに独立したcheckpoints行で記録し、共通55表のcursorは変更しない。INSERT/値assertion/進捗更新のatomic batch、応答喪失後の再開、完了済みtargetの再検証を実装した。共通の連続空表もguard付きbatchで進め、scratch処理はローカルtransactionへ集約した。test timeoutは変更していない。

実PG→archive→workerd D1で実StateGraphの会話継続・過去状態からの分岐・interrupt再開を検証した。namespace/legacy TASKS/Map/Set/bytes/数値version、破損入力の書込前拒否、checkpoint commit応答喪失を含む新規13件と共通import25件の計38件が成功した。API/運用script型チェック・lintも成功した。
Embedding/Vectorize、visual参照の移行、リモート投入、本番データ・検索品質・性能・復旧演習は継続対象。execution_complete=falseを維持し、本番DB/設定は変更していない。

追加で既存のD1/PostgreSQL/memory checkpoint契約とD1 LangGraph実行の4ファイル22件が成功し、今回の関連確認は計60件となった。git diff --checkも成功した。


### pgvectorのprivateシーン変換準備

書込前preflightに1536/768のEmbedding変換を追加した。private SQLiteに共通videosの所有者とscene/model spaceの一意性だけを保持し、sourceをstreamで処理する。既存Embedding・本文・時刻・evidence typeを維持し、再Embeddingしない。
source rowとmetadataの所有者、参照動画、UUID/整数、vectorの次元・float32有限性・非ゼロ、payload予算を検証する。不整合時はtargetの共通rowを書き込む前に停止する。archive/video/model spaceの決定的revisionとlive writerのvector ID生成を利用する。private spoolは同一入力で同じ内容になる。
これは変換準備段階であり、scene/publication/outboxのtarget投入とVectorize配信は未実装のまま明示する。pending_special_rowsからEmbeddingを差し引かず、実行完了と扱わない。本番DB・設定は変更していない。

検証はシーン変換13件と実PG→archive→D1共通import29件の計42件が成功した。実pgvectorのexport値・時刻の保持と不正所有権/参照/ゼロvectorの書込前拒否を含む。型チェック・lint・git diff --checkも成功した。


### D1シーン・publication・同期outboxの投入

privateシーンspoolをD1へ投入する専用フェーズを追加した。common/checkpointsとは独立したmigration_importsのscenes cursorとarchive/plan hashを持ち、各シーン、同期タスク、video source version、model space別published run/head、値assertionと進捗を同じatomic batchで書く。
応答喪失時は同じarchiveから再開し、完了済みretryも値/件数/FK/公開状態を再照合する。expected_scenesは全行投入後に正本の件数から復元する。1536/768は同じsource versionで別run/headとなる。

offline中はschedulerも停止し、claim/配信済みoutboxは再import対象にしない。D1投入が終わったEmbeddingはpending_special_rowsから除き、未配信数はpending_vectorize_rowsへ分ける。scene_import_completeはVectorize配信完了を意味せず、execution_complete=falseを維持する。
実PG sourceの両次元同居、commit応答喪失、完了後の本文/task/head改変検出、および実LangChain同期処理（Vectorize fixture）からD1本文hydrate/所有権チェックまでを検証対象に追加した。リモートVectorizeの配信照合・検索品質・本番リハーサルは継続対象である。

今回の最終検証はcommon/scene import35件とcheckpoint import・scene preparation・scene writer/sync45件の計80件が成功した。型チェック・lint・git diff --checkも成功した。初回は新規テストの数値ソート/構文を修正し、並列fixtureによる拡張作成の競合をadvisory transaction lockで直した。型チェック/lint同時実行中の既存2件timeoutは、検証処理終了後のcommon35件再実行で解消した。timeout値は変更していない。検証用PG containerはテスト終了後に削除し、本番DB/設定は変更していない。


### legacy visual参照の書込前関係検査

PGではlegacy object key、D1ではobject_version/publication_versionを含むキーを使う差を確認した。共通行のコピーだけでreadyデータを公開しないよう、pending_visual_runs/visual_objects_migratedを明示し、書込前にprivate SQLite上で動画/run/chunk関係を検証する。
run UUID、duration/chunk_count、uploaded動画とfile一致、所有run・chunk index・全grid・frame_countを検査する。readyで未完成/全空、stale file、orphan/incomplete gridを拒否する。完成済み0 frameと未完成NULLを保持し、run単位で最大600 chunkのprivate計画を出力する。
この段階は計画生成であり、legacy objectの検証/コピー、manifest/publicationとcleanup台帳の復元は未完了のまま明示する。本番DB/設定は変更していない。

visual run/chunkがともに0件の場合はprivate空計画だけを作り、全動画の再走査とSQLite作成を省く。runなしでchunkがある場合は早期拒否する。

最終検証はvisual計画15件と実PG→archive→D1共通import39件の計54件が成功した。初回の両モデル再import1件timeoutを受け、visualなしの追加走査を省いた後に全54件を再検証した。timeout値は変更していない。型チェック・lint・git diff --checkも成功した。検証用PG containerは全テスト終了後に削除した。


### legacy visual wire formatの検証と再試行可能なobjectコピー

完成済みchunkのpackとcoarse JSONを照合するvisual-artifactsを追加した。video/duration/frame count、時刻・連続offset・全byte範囲、JPEG境界、疎サンプルの画像参照/base64一致を検証し、不正UTF-8/JSONとproviderエラーは固定文言にする。空の完成chunkと未完成NULLを区別する。既存runtimeと同じwire検証であり、JPEGデコーダの完全検証とは区別する。
private stagingへobjectを固定し、archive/run/object内容のhashからversionを作る。readyのmanifest/overviewは検証済みchunkから再構築する。object inventoryに全体hashを持たせ、ローカルpathを除いた内容で決定性を保つ。

copyVisualArtifactsはprivateな計画コピーを検証してから、create-onlyのdestinationへcopyし、前後の内容照合を行う。既存の異なる内容は上書きせず拒否し、PUT成功応答喪失後は内容一致で再開する。変換元・staging・planの後変更も検査する。D1参照の更新とは独立した段階であり、visual_objects_migrated=falseを維持する。
source/destinationのremote接続とD1参照/cleanup台帳の反映は継続対象。共通importにこのcopyを自動統合しておらず、remote資源/本番データ/設定は変更していない。

最終検証はvisual artifact検証/コピー26件とvisual計画15件の計41件が成功した。型チェック・lint・git diff --checkも成功した。コピー試験は注入したdestination fixtureを使い、remote R2へのコピー成功とは区別する。


### visual migrationのR2 binding・D1 publication統合

r2VisualMigrationStorageを追加し、既存のmedia/ prefix、bounded stream読込、create-onlyの条件付きPUTを実装した。Cloudflareの現行R2 API仕様を確認し、実workerd bindingで上書き拒否を検証する。初回の画像読込試験でmedia/ prefix不足を検出し、source/destination双方を既存runtimeの規則へ合わせた。

importCommonTablesの明示visualStorageオプションからvisual移行を実行する。未指定時のpending表示は維持する。visuals進捗行でarchive/object inventoryを固定し、コピー前にcleanup ledgerを作り、コピー照合後にchunk参照とpublished ledgerをatomic batchで反映する。ready publicationは全chunkのversion参照を確認してから反映する。legacy source objectは削除しない。
PUT失敗・参照commit応答喪失は同一入力で再開し、別入力/source変化・参照改変は拒否する。visual_objects_migrated=trueはこの段階のみの完了で、execution_complete=falseを維持する。remote接続CLIと本番相当リハーサル、Vectorize配信照合・検索品質・性能・復旧/E2Eは継続対象。本番DB/設定は変更していない。

検証は実PG共通import40件、workerd D1/R2 visual移行6件、artifact26件、既存visual契約6件の計78件が成功した。さらにコピー中の動画file変更を公開直前に再検証するguardと1件の試験を追加し、visual移行7件を再実行して成功した。既存readFocusFramesによるversioned manifest/chunk読込を確認した。検証用PG containerは全PGテストの終了後に削除した。remote R2/本番への操作は行っていない。
型チェック・lint・git diff --checkも成功した。


### Vectorizeの配信後・元Embedding内容照合

verifyMigratedSceneVectorsを追加した。private prepared入力を固定し、profile別bindingの次元確認とgetByIdsで全期待vectorを取得する。元のfloat32値、metadata/user/video/scene/revision/vector ID/namespaceを照合し、D1本文/時刻/所有者/scene-task対応と配信完了状態も確認する。provider呼出後に全D1行・receipt・件数を再検証する。
未反映/不一致/未完了taskは件数で報告し、providerエラーは固定文言にする。入力pathの後変更を防ぐprivate作業コピーを使う。verifyArchiveSceneDeliveryは元archiveの検証・期待値再生成から接続し、配信済みoutboxを再import/リセットしない。

配信確認はID指定での値取得を意味し、ANNの検索可視性/Recall/ランキング/余分なvector不存在を証明しない。search_quality_verified=falseとexecution_complete=falseを維持する。remote Vectorizeの実測と検索品質・性能・全体移行リハーサルは継続対象で、本番DB/設定は変更していない。

検証は配信照合19件と既存writer/sync19件の計38件が成功した。実PG export→D1 import→LangChain配信→元archiveからの照合を既存共通import suiteの1件で接続し成功した（同suiteの他39件は今回の絞込みでは未実行）。型チェック・lint・git diff --checkも成功した。Vectorize providerはfixtureでありremote配信成功の証拠とは区別する。検証用PG containerはPG試験終了後に削除した。


### 実Cloudflareの移行専用D1/Vectorize環境と合成probe

Wrangler OAuth接続とD1/Vectorizeの既存一覧が空であることを確認し、専用D1（APAC）と768/1536 cosine indexを作成した。user_id/stringとvideo_id/numberのmetadata indexも作成・read-back照合した。D1には全18 migrationを適用した。独立configはproduction route/secretを持たず、本番wrangler.jsonc/Neon/R2を変更しない。

getPlatformProxyのremote bindingを使い、D1への合成user/video/scene、実LangChain Vectorize配信、getByIdsとscope検索、D1本文hydrateを接続した。4vector・両次元のowner検索・別owner拒否に成功し、終了時に合成vector削除反映を確認した。初期化から確認まで97,575msで、API単体性能とは区別する。非同期可視化は0→1→2→3→4件と段階的だった。
helperのusername重複とcleanupのFK順序を実環境で修正した。cleanupはvector削除観測後にD1行を依存順で消し、再試行用IDを先に失わないようにした。値を含むprovider診断を直接出さず、合成probeの段階/件数とredactした診断だけを出す。
本番データ・検索品質・性能/コスト・全体E2E/復旧と本番切り替えは継続対象。専用リソースは後続リハーサル用に保持する。

最終確認はremote合成smokeと専用cleanup-onlyの成功、既存scene writer/sync19件の成功、API/移行tool型チェック・lint・git diff --checkの成功。D1/Vectorizeの専用リソースは存在し、合成データは削除確認済み。本番wrangler.jsoncの差分はない。


### 固定staging targetのアーカイブ移行CLI

db:d1:staging:migrateを追加し、import/deliver/verifyを分離した。DB/account/index/main/nonpublic設定を共通validatorで固定照合し、secret/追加binding/production routeやprofile取り違えを拒否する。smokeも同じvalidatorへ移行した。
private archiveを固定・全件検証/準備してからremoteへ接続し、importは凍結コピーを使う。deliver/verifyは同一archiveのscene receiptを要求し、配信済みデータを再importせずに元Embeddingを照合する。配信は指定最大件数内に限定し、失敗/lease lossで止める。
未反映/不一致のverify、配信失敗/lease lossは終了2にし、実行エラーの1と区別する。visual binding未設定の固定configではvisual runの投入を既定拒否し、DB先行リハーサルを明示した場合だけpendingを残して進める。execution_complete=falseは維持する。
本番DB/設定は変更しておらず、新CLIによる実データのremote importは未実施である。

最終検証はstaging target/CLI引数/終了gate28件と実PG exportを使うCLI engine 3件の計31件が成功した。engine試験は3phase接続/解放、破損archiveの接続前拒否、visual既定拒否/明示pending許可を確認する。同suiteの他40件は今回の絞込みでは未実行。型チェック・lint・git diff --checkも成功した。検証用PG containerは対象試験終了後に削除した。


### 実PG archive→remote D1/Vectorizeの合成リハーサル

local-onlyのfixture生成CLIを追加した。使い捨てPG上の新規schemaに現行57テーブルと合成11行（auth/session、video/course/Q&A、両次元Embedding）を作り、private archiveをexportしてsource schemaを削除する。
専用remote D1へ2回importし、共通55表の照合・13採番復元・2 scene投入と同一入力の再実行に成功した。実Vectorizeへ2件配信し、元archiveと値/metadataを照合してchecked=verified=2、missing=mismatched=pending=0を確認した。
さらにremote opt-in Better Auth試験で移行credentialによるsignin、D1からの発行session取得、元session行保持を確認した。発行sessionはfinallyで開始前との差分だけ削除する。通常CIはこのremote試験をskipする。
合成rehearsalデータ/receiptは後続検証用に専用targetへ保持する。本番DB/設定は変更しない。visual/checkpointはこのremote archiveでは0件であり、実ユーザー、cookie維持、検索品質・性能、復旧/本番切替は継続対象。

最終確認としてremote認証1件の成功と、opt-in未指定時の1件skipを確認した。local-only source guardは非loopback接続を初期段階で拒否し、出力archiveを作らなかった。型チェック・lint・git diff --checkが成功し、本番wrangler.jsoncの差分はない。local fixture用PG containerは終了後に削除した。合成archiveはprivate権限の一時ディレクトリへ保持している。


### 実D1 Time Travelの合成データ復旧演習

専用stageの68テーブル/52行（migration履歴・採番を含む）をprivate hash/countへ記録し、Time Travel bookmarkを保存した。合成video titleの1行変更で差分を観測し、復旧前verifyの拒否を確認した。proxyを閉じ、保存bookmarkへ実Cloudflare Time Travel restoreを実行した。
復旧後は元hashと完全一致し、元archiveと実Vectorizeの2ベクトル照合もmissing/mismatched/pending=0、remote認証試験も再度成功した。データ本体/認証tokenを比較ログに出さず、bookmark/undo bookmarkはprivate fileへ保持する。
比較toolは専用targetと合成2ユーザーに限定する。空tableのDDL/column変更と採番変更も検出し、1000行を超えるtableは拒否する。独立readを25文以下のbatchにまとめ、元のfingerprintを変えずに往復を減らした。table外index/trigger DDLは対象外で、汎用production比較/backupとして扱わない。
実ユーザー・稼働中job/外部writer、R2/Vectorize同時復元、Neon逆移行やRTO/本番切り戻しは未検証。本番DB/設定は変更していない。

最終確認は新しいfingerprint比較6件と復旧後のremote認証1件が成功し、実Time Travel restore・68table hash一致・元archiveとの実Vectorize照合2/2成功を確認した。型チェック・lint・git diff --checkも成功した。


### 本番メタデータ確認と最新main統合の開始

既存audit接続のread-onlyメタデータ確認で、作業開始後のmainにClassroom/teaching連携が追加され、本番にも反映されていることを確認した。audit roleのアプリtable SELECTは0で、レコード内容/正確件数は取得していない。保護されたbackup/migration認証をローカルへ取り出さず、既存AWS境界を維持する。

現在の変更全体をprivate patch/tarに保全し、最新mainベースの別worktreeへ適用した。mainのPG migration0062〜0064を保持し、未公開のmultipart追加分は生成器で0065へ再生成した。SQLiteにもteaching_connections/classroom_authorを追加してD1 migration0018を生成し、56共通table+2 vector tableのmanifest coverageは成功した。機能コードのmerge conflictと新main機能のD1 repository対応は未完了であり、まだ元worktreeへ昇格/本番deployしていない。

PostgreSQLのvarchar表記を正規化してsource metadataを再評価し、最新mainの現行tableの列契約に差分はなかった。残る旧table候補は保全方針を決めるまで未マッピングとして拒否する。メタデータ専用collectorの5件と対象lintは統合用worktreeで成功した。全体typecheck/testsは競合解消後に実行する。


### 最新main統合：Classroom認証情報更新の共通化

隔離した統合作業ツリーで、Classroomの`replaceCredentialPayload`を共通CredentialRepositoryへ移した。PostgreSQLとD1の両実装が、ID・種別・有効期限を条件に既存行だけを更新する。有効期限の延長、失効済み情報の更新、削除済み情報の再作成を行わない。

同じ契約テストがD1 workerdで9件、ローカルPostgreSQLで9件成功し、対象ファイルのESLintも成功した。`features/lti/store.ts`の競合は解消したが、最新mainとの統合には12ファイルの競合が残る。この変更は元の作業ツリーへ未反映で、本番環境への適用も行っていない。


### 最新main統合：教員所有権・Classroom質問者情報

隔離した統合作業ツリーで、次を反映した。元の作業ツリーへのコード反映、本番DB・Vectorize・R2・APIの更新は行っていない。

- LTI登録を教員の接続・講座所有権で判定し、対象プラットフォームだけを取得する。接続管理者が停止されても教員本人の正常な接続を失わせない。
- 教員が選択した講座の読み取りを両DBのRepositoryへ移し、教員本人が所有する完了済みの動画だけを返す。
- Classroom・Moodleの検証済みセッションから質問者情報を保存し、履歴・CSVへ反映する。別講座や未知のtransportの情報は採用しない。
- 教員の接続レビュー・一覧・切断・確定を共通契約へ移す。PostgreSQLは行ロックとクラス単位のadvisory lockを維持し、D1はチケット・既存接続のスナップショットと現在の権限を原子的バッチ内で照合する。切断後も所有権を保持し、他教員による上書きを拒否する。
- 接続確定前に共有サービスが外部の教員権限を再検証し、Repositoryはその時点のチケットと確定時のチケットが同じことを確認する。
- 教材同期の起床時刻は接続管理者の状態から独立させ、取り込んでいるmainの仕様と整合させる。

両DBを含む10ファイル・109件の対象テストが成功した。内訳は教員接続20件、LTI登録・講座読み取り18件、接続認証・管理20件、チャット22件、D1起床時刻2件、PostgreSQL起床時刻27件。教員接続には同時確定、チケット単回消費、別教員の競合、失効・状態変更、保存失敗時のロールバックを含む。対象ESLint、変更した本番コード17ファイルのTypeScript診断、移行manifest検査も成功した。

全体の型チェックは残る6ファイルの競合で失敗しており、統合作業ツリーはまだデプロイできない。教材同期・プライバシー・教材アップロードの統合、依存関係の再インストール、全体の型チェック・回帰テスト・E2Eが残る。特に接続認証はmainと同じく接続自体を識別するため、後続の教材操作で教員の所有権を解決・再検証する対応を完了させる必要がある。接続管理者への暗黙のフォールバックは行わない。


### 最新mainとの統合完了とローカル回帰検証

残っていた6ファイルの競合を解消し、教材同期・アップロード・教材編集・タグ・集計・プライバシーを、接続管理者と講座所有教員が異なるモデルへ統合した。利用枠と動画は教員のアカウントへ紐付け、確定時に教員接続・講座・セッション・世代・リースを再検証する。同期が未接続クラスの講座を自動生成することはなく、切断済みクラスを他の有効な接続で代替することもない。旧push型の明示的な教員接続は維持する。

ClassroomとMoodleの再生メタデータ、教員接続bootstrapの単回nonceも共通契約へ移した。PostgreSQL固有の講座認可SQL・作成冪等性・LTI操作予約はPostgreSQLアダプター内へ移動した。オンプレミス専用のアカウント作成機能は引き続きPostgreSQLを使用する。

統合したlockfileでnpm/uvの依存関係を再構築した。永続化テスト122ファイル・1,346件、別のAPI回帰169ファイル・2,182件、workerd API 13ファイル・59件、Python Worker 594件が成功した。skipはそれぞれ1件、93件、0件、114件で、外部サービスを必要とする検証の完了とはみなさない。全workspaceの型チェック、API ESLint、オンプレミスNodeビルド、PostgreSQL/D1双方のDrizzle検査、migration manifest、差分の整形検査も成功した。教員bootstrap nonce追加は別途両DBと既存教員接続経路の31件を実行し成功した。

元の作業ツリーを統合開始時のprivate退避とファイル単位で比較し、以後の差分がこちらで加えたpackage scriptと設計記録の2ファイルだけであることを確認した。退避を保持したうえで、検証した統合内容を元の作業ツリーへ戻す。本番の切り替え・本番データ移行・ステージング0018適用はこの段階では実施していない。
