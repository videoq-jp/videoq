# 「実践クリーンアーキテクチャ」の反映

参照動画: https://www.youtube.com/watch?v=BvzjpAe3d4g （なるセミ、約1時間52分）

一次資料:
- 動画説明欄のスライド: https://speakerdeck.com/nrslib/clean-architecture-with-java
- Java実装: https://github.com/nrslib/play-clean-java
- 補足実装: https://github.com/nrslib/itddd/tree/master/CleanLike

動画の日本語自動字幕全体と説明欄の実装を確認して整理した対応表。自動字幕の誤認識はコード・説明の文脈で補う。雑談や別回の予告、Java固有のDIアノテーション、例題ユーザー名の文字数はVideoQの仕様へ転用しない。対象はこのスレッドで依頼されたバックエンド。実装例のコピーではなく、以下の仕組みと開発手順を実際に動く形で反映する。

| ID | 動画内の論点・位置 | VideoQに必要な状態 | 検証 |
| --- | --- | --- | --- |
| CA01 | 16–23分: ports/adapters、業務中心 | domainがHTTP・DB・SDK・applicationに依存しない。ルールを所有コンテキストへ集約 | domain/architecture境界テスト、DOMなし型検査 |
| CA02 | 23–31分: applicationと詳細の分離 | ユースケースはポートを受け、外側で実装を組み立てる | 実依存グラフ、サービスのテスト |
| CA03 | 35–44分: 入力変換・入出力データ | controllerは入力を内部コマンドへ変換し、業務オブジェクト・DB行をそのまま公開しない | APIの入出力スキーマ、型検査、契約テスト |
| CA04 | 39–43分: repositoryとdomain object | 永続化の型と業務上の状態・遷移を分離。更新時の整合性を維持 | D1/PostgreSQL契約テスト |
| CA05 | 49–57分: 仮実装・in-memory・DI切替 | DB・外部APIなしで本物のユースケースを動かせるin-memory adapter。通常・stubの構成を選択可能 | アダプター差替テスト、ローカル起動 |
| CA06 | 50分: 例外時の動作確認 | 永続化を壊さず意図したエラーを再現できる | シナリオエラーとAPI応答テスト |
| CA07 | 52–62分: Webでは出力DTOを返す | 戻り値を外側でHTTP/tRPCへ変換。形式だけのpresenter/output callbackを強制しない | application境界と応答の契約テスト |
| CA08 | 63–68分: typed use-case bus | 入力と出力の対応を型で維持し、登録した実装へdispatch。実行単位でDI構成を分離 | 型の負例テスト、production/stub登録テスト |
| CA09 | 69–71分: scaffoldingと登録の自動化 | コマンドで契約・ユースケース・仮実装・登録・テストの骨組みを生成 | 仮ディレクトリで生成・型検査・衝突拒否 |
| CA10 | 71–74分: JSONシナリオ | JSONで返却値・連続呼出結果・エラーを変更し、再現・再利用可能。サーバー再起動なしに変更を反映 | シナリオ読込・逐次/並行呼出・再読込テスト |
| CA11 | 73–74分: フロント先行と実装切替 | API契約を使うローカルprototypeが実際に起動し、productionのルーター/スキーマと互換 | 実HTTP smoke、DB/外部接続なしの確認 |
| CA12 | 75–82分: 開発のレール・DIP | 導入手順・追加手順・構成の判断・検証コマンドが一貫し、道具を実プロジェクトで使用 | ドキュメントと実行結果の照合 |

## 反映方針と完了の扱い

業務ルールの所有先・招待の状態遷移・DI・単純な戻り値という基盤に、DBなしの先行開発、シナリオ切替、typed use-case bus、生成ツールを接続する。設計の説明に加え、本物のユースケースと同じルーターを使って実行できることを検証する。

完了は、上の各項目を現行コードと実行した検証に対応付けた後に判断する。既存の認証・原子的更新・outboxを試作用実装へ置き換えず、外側の構成で選ぶ。

## 実装の対応先

- CA01–CA04: `domain/`、`application/`、`persistence/contracts/`、`integrations/`の既存分離に加え、スキル生成のcore/serviceからtRPCとAbortSignalへの依存を除いた。外部AI出力のスキーマ検証はprovider adapterで維持する。入力→ユースケース→出力の境界は `trpc/handlers/course-procedures.ts` でも本番・in-memoryで共有する。
- CA05–CA08: `application/use-case-bus.ts` と `application/scenario.ts`。既存の全JSON APIのdispatcherと講座ユースケースの本番compositionが同じ型付きbusを使う。`persistence/memory/course-repository.ts` は本物の講座ユースケースに差し込むローカル実装。D1/PostgreSQLは引き続き本番の構成が選ぶ。
- CA09: `scripts/scaffold-use-case.mjs`。契約・ユースケース・型付きproduction/stub composition・JSON fixture・回帰テストを生成し、`integrations/generated/registry.ts` に自動登録する。二重生成・不正な型・書込先のsymlinkを拒否し、登録更新は排他的に行う。
- CA10–CA11: `integrations/prototype/` と `runtime/prototype*.ts`。全82手続きの既存tRPCルーター・入力・出力スキーマを使う。JSONの成功/失敗と順序、変更時の再読込、認証済み/匿名/管理者の開発用コンテキスト、SSEなどraw HTTPのfixturesを扱う。
- CA12: 下記の開発手順。新規ポートもgeneratorで同じ構成に揃え、実装は後からproduction compositionへ接続する。動画のバスを分散イベント配送には使わない。DBの原子的更新とoutboxは既存のまま維持する。

## DBを待たずにAPIを動かす

リポジトリのルートから:

```sh
npm run dev:prototype
```

`http://127.0.0.1:8788` で起動する。DB、Cloudflareのbinding、LLM、メール、キューの設定は不要。通常のproduction entrypointにはprototypeを読み込ませない。

既定の `memory` では講座の作成・取得・更新・削除・並び替え・共有を本物のユースケースとin-memory repositoryで実行する。状態はプロセス/アプリインスタンスの寿命だけ保持する。他の機能は `apps/api/prototype/default.json` のシナリオから返す。

すべての手続きをJSONの仮実装へ切り替える場合:

```sh
VIDEOQ_PROTOTYPE_MODE=stub npm run dev:prototype
```

独自のシナリオは `VIDEOQ_SCENARIO=/absolute/path/scenario.json` で選ぶ。各JSON APIの結果は実際の出力スキーマで検証する。未設定の操作は `SCENARIO_MISSING` で明示的に失敗し、実DBへフォールバックしない。全手続きのadapterは存在するが、既定JSONは画面開発の起点となるfixtureだけを用意している。必要な画面の応答を追加して使う。

別ターミナルでWebフロントを起動する場合:

```sh
VITE_API_PROXY_TARGET=http://127.0.0.1:8788 npm run dev:web
```

既存の `/api` proxyで同じルーター・スキーマに接続する。JSON内の `session` は開発用identity。実際の認証や外部連携を検証するときは本番と同じ通常の開発環境へ切り替える。

### JSONの構造と再現

```json
{
  "version": 1,
  "repeatLast": false,
  "session": { "userId": "prototype-user", "admin": false },
  "procedures": {
    "courses.list": [
      { "output": { "data": [], "meta": { "total": 0, "limit": 24, "offset": 0 } } },
      { "failure": { "kind": "unavailable", "code": "PROVIDER_DOWN", "message": "Please retry" } }
    ]
  },
  "http": {
    "POST /api/chat/message": [
      { "status": 200, "headers": { "Content-Type": "text/event-stream" }, "body": "event: done\ndata: {}\n\n" }
    ]
  }
}
```

同じ手続きの呼出し順にstepを消費する。失敗も1stepとして消費する。`repeatLast: true` なら最終stepを反復し、falseなら尽きた時点で `SCENARIO_EXHAUSTED` を返す。異なる手続きは独立した位置を持つ。並行呼出しも同じstepを二重消費しない。ファイルの内容が変わるとスキーマ検証後に全シナリオ位置が先頭へ戻る。JSON修正でmemoryの講座を初期化はしない。

`http` はHTTPメソッドとパスの完全一致で選ぶ。JSON以外のContent-Typeではbodyに文字列を指定する。これはプロトコルの画面状態を再現する機能で、外部認証・multipart upload・provider動作そのものの実装ではない。それらは本番adapterの契約テストで検証する。

## 新しいユースケースを同じレールで追加する

仕様ファイルの例は `apps/api/prototype/specs/course-outline.json`。業務上の目的、context、名前、入力・出力の型、出力サンプルを指定する。型はstring/number/booleanとそれぞれの配列をサポートし、生成後に複合モデルへ拡張できる。

```sh
npm run use-case:new --workspace @videoq/api -- prototype/specs/course-outline.json
npm run use-case:run --workspace @videoq/api -- learning.courseOutline '{"courseId":1}' prototype/use-cases/learning-course-outline.json 2
```

生成されるもの:

1. `features/learning/use-cases/course-outline/contracts.ts`: transport非依存のInput/Output/InputPort。
2. 同じ場所の `service.ts`: 外部能力を受けるinteractor。
3. `integrations/generated/learning/course-outline.ts`: production/stubの型付き登録、外側の入出力スキーマ。
4. `prototype/use-cases/learning-course-outline.json`: 再利用できる仮応答。
5. `test/generated/learning-course-outline.test.ts`: generated portを実行する回帰テスト。
6. `integrations/generated/registry.ts`: 名前と実装の自動登録。

`use-case:run` は登録済みportをJSON fixtureで実行するCLI。production構成では生成した `definition.create({ mode: 'production', dependencies: ... })` に本物の能力を渡す。依存を渡すまでは仮データで本番成功を装わない。新しい公開APIが必要なら `packages/trpc` の入力・出力・routerとtransport handlerを追加し、入力を内部Inputへ変換してbusを呼び、OutputをAPI表現に変換する。内部にHTTP/tRPC型を持ち込まない。

## 検証コマンド

```sh
npm run typecheck --workspace @videoq/api
npm run lint --workspace @videoq/api
npm run test:unit --workspace @videoq/api -- --maxWorkers=4
npm run test:workers --workspace @videoq/api
npm run build:node --workspace @videoq/api
```

`use-case-bus.test.ts` は登録の差替・失敗・順序・分離、`prototype.test.ts` は本物のrouter経由のCRUD・認証・入力/出力検証・再読込・SSE、`scaffold-use-case.test.mjs` は一時プロジェクトへの生成・自動登録・型の負例・生成されたテストとCLIの実行・衝突拒否を検証する。

## 反映後の検証結果（2026-11-27）

| 検証 | 結果 | 確認した範囲 |
| --- | --- | --- |
| API全体 `test:unit -- --maxWorkers=4` | 367ファイル成功、3,718テスト成功 | 既存API・業務ルール・D1・ツール・境界。外部環境を要する128ファイル/1,584テストは既存条件でskip |
| Workers `test:workers` | 16ファイル、118テスト成功 | 実workerdでのAPI・ランタイム契約 |
| PostgreSQLの講座/スキル保存 | 2ファイル、19テスト成功 | 一時ローカルDBで契約・ロールバック・分割保存 |
| Python worker境界 | 1テスト成功 | domain/use_casesから外部実装への依存禁止 |
| busとscaffoldの型検査 | 成功 | 誤った名前・入力・出力はコンパイルで拒否。生成した別プロジェクトも型検査・テスト・CLIを実行 |
| native HTTP smoke | memory/stubとも成功 | 実際のNodeサーバーでhealth、identity/session、講座作成・取得、JSON fixtureの応答。検証サーバーは終了済み |
| Node本番ビルド | 成功 | workspaceコードのbundleとprototype/memory実装の混入禁止 |

prototypeのfixtureは外部サービスの動作そのものを再現しない。公開APIの型と表示状態を先に作り、後から本物のadapterへ切り替えるために使う。外部APIの接続・認証・課金・キュー配送は、それぞれの実adapterの検証を通す。
