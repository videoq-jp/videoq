---
title: APIを変更する
description: tRPCの入力・出力からHonoのハンドラー、サービス、DBまで変更を追う。
---

# APIを変更する

通常のJSON APIは、`packages/trpc` の共有契約から変更します。HonoはHTTPの受け口を担当し、実際の処理をAPI側のハンドラーにつなぎます。

Honoのドキュメントにある `hc` を使ったRPCとは別に、このプロジェクトでは **tRPC** を使っています。入口は `/api/trpc` です。

## 編集しながら動作を見る

[開発環境](../getting-started/local-setup.md)を起動しておきます。ComposeのAPIにはソースコードがマウントされ、Wranglerの開発サーバーが変更を読み込みます。リクエストの結果とログを合わせて確認します。

```bash
docker compose logs -f api
```

依存関係やDockerの構成を変更した場合は、必要に応じてAPIのイメージを再ビルドします。

## 例: タグ作成の入力を追う

`packages/trpc/src/inputs/tags.ts` では、タグ作成の入力が次のように定義されています。

```ts
"tags.create": z.object({
  name: z.string().min(1).max(50),
  color: tagColorSchema.default("gray"),
}),
```

これは既存定義の抜粋です。`name` は1〜50文字、色の省略時は `gray` になります。値の検証と既定値がここで決まります。

## 変更する順番

1. **入力を定義する。** `packages/trpc/src/inputs/` で、受け取る値・制約・既定値を決めます。
2. **出力を定義する。** `outputs.ts` / `model-schemas.ts` で、呼び出し側に返す形を確認します。
3. **操作を登録する。** `routers/` でqueryまたはmutationと、必要な認証を選びます。
4. **APIへつなぐ。** `apps/api/src/trpc/handlers/` で入力と利用者IDをサービスに渡します。
5. **業務処理を書く。** `features/<機能>/service.ts` に処理の組み立て、`repositories/` にDBアクセスを置きます。
6. **画面の呼び出しを更新する。** 関連フックやコンポーネントを変更し、取得結果の再表示まで確認します。

新しい操作や分野を増やす場合は、共有routerの集約と `trpc/context.ts` のハンドラー登録も確認します。[タグ一覧を追う例](../getting-started/codebase.md)が入口になります。

## 権限をどこで確認するか

`protectedProcedure` はログインを確認しますが、それだけでは対象動画・タグの所有権までは保証しません。既存実装のように、サービスやrepositoryへ利用者IDを渡し、検索範囲を絞ります。

テストでは正常入力だけでなく、不正入力、未ログイン、他人のデータ、存在しないIDも確認します。[認証とアクセス権](../concepts/auth.md)も参照してください。

## Honoのrouteを使う場面

認証、MCP、Stripe webhook、動画バイナリ、multipartアップロード、チャットのSSE、CSV出力などは、通常のJSON呼び出しとは形式が異なります。これらは `features/*/routes.ts` と `app.ts` で組み立てます。

通常の一覧・取得・更新を追加するときは、まず既存のtRPC routerを確認してください。

チャットSSEの `course_id` とtRPCの `courseId` は、共有の `chatCourseIdSchema` を使い、
JSONの正の整数・`null`・省略を受け付けます。不正な値は回答生成や利用量の予約前に拒否します。

## 大きな動画のアップロード

S3ストレージが有効な場合、Webクライアントは100 MiB以上のファイルにマルチパートアップロードを要求します。それより小さいファイルは1回のPUTのままです。どちらの経路でも、動画を予約する前にアカウントのアップロード上限と保存容量の上限を確認します。

1. `videos.requestUpload` は `multipart: true` を受け取り、動画と `multipart.part_size`、`multipart.part_count`（`upload_url` はnull）を返します。
2. `videos.uploadPartUrl` は動画IDとパート番号を受け取ります。所有者とアップロード状態を確認し、想定どおりの長さに署名して、アップロードの活動時刻を更新します。
3. ブラウザは `File.slice` を使い、同時に最大3パートを送信します。パートは通常64 MiBで、より大きなオブジェクトでは10,000パート未満に収まるよう大きくします。再試行のたびに新しいURLを取得します。R2のCORSでブラウザへ `ETag` を公開する必要があります。
4. `videos.completeMultipartUpload` は番号付きのETagを受け取り、オブジェクトを組み立ててサイズを確認し、文字起こしを1回だけキューへ入れます。完了処理の再試行で、ストレージ応答の消失やDBトランザクションの失敗から回復します。
5. `videos.abortUpload` は未確定のアップロードだけを削除します。確実なクリーンアップでマルチパートセッションを中止し、保存データを削除して予約容量を返します。

1回のPUTの上限は5 GiB、マルチパートはアカウントの上限の範囲で最大5 TiBです。[R2のアップロード制限](https://developers.cloudflare.com/r2/objects/upload-objects/)を参照してください。パートのURLは1時間で期限切れになり、各転送の直前に発行します。パートURLの要求が2時間ないアップロードは放棄されたものとして扱います。転送中であれば2時間を超えても続行できます。失敗したパートは最大3回再試行します。ページを閉じる・再読み込みすると、アップロードをやり直す必要があります。放棄されたデータはメンテナンスタスクが回収します。

API・workerより先にマイグレーション `0030_multipart_upload_sessions` を反映し、その後にWebクライアントを反映します。既存の本番CORS設定は `ETag` を公開しています。本番の作成・完了・中止はR2バインディング、ローカルのGarageはS3 APIを使います。動画データはAPI Workerを通過しません。

Python workerはアップロードされたメディアをHTTP範囲リクエストでオブジェクトストレージから直接読み、音声抽出と画像キャッシュを作成します。そのため、元ファイルと同じサイズの一時ディスクは必要ありません。既存のメディア処理とLambdaの時間制限は引き続き適用されます。保存容量の上限は処理時間を保証するものではありません。

## MCPツールの入力

`apps/api/src/lib/mcp-tools.ts` の入力スキーマを、MCPへの登録とツール実行で共用します。
ID・バイト数・ページ指定は、各項目の範囲内の整数か、`42`・`"42"` のような10進数字の
文字列を受け付けます。真偽値・配列・16進数や指数表記の文字列・未定義の項目は、
対象リソースにアクセスする前に拒否します。ページ指定の既定値もスキーマで定め、
ハンドラーは検証済みの型付き引数を再変換・再補正せずに使います。

## 確認する

```bash
npm run typecheck
npm run test:api
```

`typecheck` は画面側を含めた契約の不整合も検出します。APIのテストはNode.jsの単体テストとWorkers実行環境のテストを含みます。DB統合テストには別途検証用DBが必要です。[テストの使い分け](testing.md)に実行条件をまとめています。

**関連:** [tRPC APIの詳細設計](../architecture/trpc-api.md)、[DBを変更する](database.md)。
