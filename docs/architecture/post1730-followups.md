# PR #1730 後の契約・境界の修正

追跡: #1731。ここでは追加監査 #1732〜#1739 の判断と保証範囲を記録する。

| issue | 判断の正本・実行責務 | 回帰検証 |
| --- | --- | --- |
| #1732 | `lib/rate-limit-history` の予約ID別返却。scopeの方針は引き続き `domain/operations/throttle-policy` | `contracts/rate-limit.contract` をMemory・実PG・workerd DOで実行。重み・二重返却・期限・数値の旧履歴。`throttle-compensation` はA待機→B成功→A拒否を検証 |
| #1733 | `enforceThrottles` が成功応答を受けた先行予約だけ補償。失敗した現在のconsumeは成否不明として保持 | 同テストで後続throw、応答前commit、返却失敗、元の例外の保持を検証 |
| #1734 | shared kernel `text-value` がNULを拒否。講座名・動画タイトル・アップロードfilenameは既存の正規化に加えて適用 | `course-name-contract`、`text-value-contract`、`video-upload-service`、PG/D1共通course契約で作成・更新・直接呼出しを検証 |
| #1735 | shared kernel `youtube` がURL上限と許可されたparts/IDを所有。URL構文のparseは入力/実行adapter | `youtube-input-contract` の200/201/247境界とhost/形式、既存 `youtube` とonprem機能ゲート試験 |
| #1736 | `domain/lms/lms-upload` の `lmsUploadMetadata` を表示とsnapshotが共有 | `lms-upload-eligibility` とupload service、PG/D1 immutable upload契約 |
| #1737 | 最小PG fixtureは宣言した列だけ実schemaと型・長さ・nullabilityを照合。production由来DDLの制約試験を別に持つ | `production-input-schema.postgres.integration` がvarchar境界・NOT NULL・share slug一意性・rollbackと、意図的な型緩和の検出を検証 |
| #1738 | 宣言/import到達・実行時の利用・挙動一致を別の保証として扱う | `ownership-negative-controls` が実course serviceをメモリ内で3種類変異させ、実装と共用する `course-name-workflow-contract` が拒否することを検証 |
| #1739 | identity domainは同期の事実判断。読み取り・再試行・ID生成は `application/identity` | 既存username/account/Google/OAuth契約をapplication入口へ接続し、`identity-domain-purity` と実認証adapterの試験を追加 |

## 入力と保存値

NULはPostgreSQLのtext/varcharに保存できないため、ここで扱う公開の講座・動画入力では保存前にvalidation errorにする。説明文と明示的な文字起こし更新にも適用する。説明文・文字起こしの空白や改行はtrimしない。通常の日本語・絵文字・結合文字を除去しない。他機能の全テキスト入力を検査済みという保証ではない。

既存のD1保存値を一括変更しない。新規作成と明示的に渡された更新フィールドに検証を適用する。既存の255 UTF-16単位の名前上限、MCP説明文の10,000文字上限など、既にある別の上限は維持する。

YouTube URLはtrim後200 UTF-16単位までとし、入力されたURLを保存する。これは既存MCPとPG `source_url varchar(200)` に合わせた保存契約で、queryを黙って削除するcanonical化は行わない。201文字以上は、動画IDを抽出できても入力エラーにする。watch、shorts、embed、youtu.beと既存のhost/scheme方針は共通parts関数が判定する。onpremのYouTube無効化は変えない。

LMSでは正の安全な整数のサイズと空でないMIMEが揃った教材だけupload情報を表示する。世代はsnapshot生成とDBの原子的更新で再確認する。表示があるだけで最新世代の処理を無条件に許可しない。

## レート制限の補償と移行

consumeごとに呼出し側が生成した予約IDを履歴の各消費単位へ保存する。返却はそのIDだけを削除するため、同時刻・重み付き・二重返却でも他の要求を消さない。拒否または後続例外では既知の成功分を返す。応答が失われた現在scope、古い数値だけの履歴、返却に失敗した分は安全側に残り、期限で失効する。返却失敗は `throttle_compensation_failed` として個人情報を含まず記録する。

PGのjsonbとDOの履歴は旧数値と新しい予約付きentryを読み取れる。SQL列の追加は不要。新形式を書いた後に旧コードへ戻す場合は履歴形式の互換性を確認する必要がある。旧PGプロセスは予約付きentryを解釈しないので、更新時は旧replicaをdrainし、新旧APIを長時間共存させない。制限履歴の全削除を移行手段にしない。

## 所有先guardの意味

`domain-rule-ownership.json` は登録された各正本・consumerと該当契約テストの対応表。guardが検証するのは次の範囲である。

| 検査 | 証明すること | 証明しないこと |
| --- | --- | --- |
| 正本の宣言名の一意性 | 登録された同名宣言の重複がない | 名前を変えた意味的なコピーがないこと |
| import/exportの到達性 | consumerから正本へのソース依存経路がある | その関数が呼ばれ、結果が判断に使われること |
| contractパスの存在 | 対応する試験ファイルが存在する | その実行・成功・検出能力 |
| 入口/ユースケース/DBの挙動契約 | 実行したケースの結果と副作用 | 未実行の全仕様や全並行順序 |
| negative control | 指定した変異を対象契約が検出できる | 全CI・全consumerのmutation score |

登録済みの全TypeScript consumer（現行47ファイル・50組の正本との対応）について、実装を除去してimport/re-exportだけを残すメモリ上の変異を評価し、静的な到達検査が成功する限界を確認する。各組は台帳の契約試験パスとも照合する。

course serviceの「呼ばない」「返却値を使わない」「旧検証へ置換」はimportをそのまま残し、実ソースを一時的にメモリで変異させて検証する。通常のcourse名契約も同じ挙動assertionを使う。ディスク上の実装は変異させない。tRPC/MCPのschemaは共通fixtureで別途実行する。

他のconsumerに新しい配線や意味の変更を加える際は、台帳で対応する契約を確認し、該当入口を実行するケースと代表的な誤配線のnegative controlを追加する。現在はcourse serviceの3変異を計測した範囲であり、全consumerで同じ検出力を証明したとはしない。

最小upload fixtureの `title <> 'reject'` はrollbackを起こすための意図的な故障注入であり、productionの業務制約とは扱わない。production由来DDLのsuiteはこの追加制約を持たない。

## identityの所有先

| 純粋な判断（domain/identity） | I/O手順（application/identity） | 外側の接続 |
| --- | --- | --- |
| username: seed/candidate/fallback | allocateUniqueUsername: 最大50回の存在照会と必要時のID生成 | auth adapterの存在照会・DB unique制約 |
| account-registration: 既存usernameの選択、初期値の組立て | initializeAccount: 必要時だけusernameを割り当てる | Better Auth作成hook |
| google-account: claimの事実、メール権威性、profile組立て | createGoogleAccountProfile: usernameを割り当てる | Google claim adapter |
| oauth-consent: 現在同意の照合、照会plan | currentConsentAllows / refreshConsentDecision: 現在の同意を毎回読み直す | Better Auth consent store |

usernameの事前存在照会は競合時の一意性を保証しない。DBのunique制約と既存の競合時処理を維持する。現在同意の再照会をcacheへ置き換えず、失効を即時反映する。domainの非同期serviceを例外として残す方式は今回は採用しない。4つのdomain/application間の対応と契約は `domain-rule-ownership.json` の `followUps` に登録し、元の27件とともに機械的に検査する。

## 再調査 #1748: LMSの新規入力と既存データ

LMS教材のdescription/transcript更新にも共通の`textValueFailure`を適用し、HTTP schemaと直接サービス呼出しの両方でNULを拒否する。LMS同期のtitle/courseTitle/contextId/resourceLinkId/filenameとexternalIdも、保存・hash・quota予約の前に拒否する。opaqueな識別子をtrimしたり、自由文の改行・空白・Unicodeを置換したりしない。既存の正常なサイズ・SRT・権限・revisionの契約は維持する。

これは新しく指定された値の検証であり、既存D1データを読み出す際の拒否や一括書換えではない。未指定の既存フィールドは維持する。全機能のテキスト入力を網羅したという保証ではない。

`persistence/contracts/material-management.contract`はdescriptionと有効SRT本文中のNULをschema/直接サービスで拒否し、教材・監査・予約・receipt・outboxが不変であることを実PG/D1で検証する。`lms-resource-sync.contract`は上記6フィールドを拒否し、リソース・動画・quota・outboxが変わらないことを同じ2方式で検証する。`lms-material-text`は認可成功後の実HTTPルートが400を返すことを確認する。

## 再調査 #1749: 重み付き消費の再試行時間

Memory・PG・DOは共通の`consumptionRetryAfter`を使う。新しい順に保持した履歴から、要求costを収めるために失効が必要な最後の単位（index=`limit-cost`）の時刻を選ぶ。競合消費がなければ、その時刻以降に同じcostが収まる。単位costの旧挙動は維持する。costがlimitを超える要求は待っても収まらず、従来どおりwindow秒の有限な拒否ヒントを返す。

共通契約は最古1単位の失効では不足するケース、返却後の再計算、複数時刻、境界時刻、単位cost、収まらないcostをMemory・実PG・実workerd DOで実行する。
