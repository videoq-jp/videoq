# D1・LangChain Cloudflare連携のセキュリティ確認

2026-11-15。確認対象は現在の移行ブランチ。クラウド本番へのDB切替や、新たな認証/モデル/権限の変更は行っていない。

## 実際に使用しているライブラリと境界

解決済み依存は`@langchain/cloudflare@1.1.0`と`@langchain/core@1.3.2`。検索アダプターは`CloudflareVectorizeStore.similaritySearchVectorWithScore`、同期アダプターは`addVectors`/`delete`を実際に呼び出す。実装を独自HTTPクライアントへ置き換えたものでも、試験時にLangChain自体をmockしたものでもない。

参照元は[公式Vectorize連携資料](https://docs.langchain.com/oss/javascript/integrations/vectorstores/cloudflare_vectorize)とインストール済みの同バージョン実装。公式サンプルには旧beta型が残るため、`langchain-vectorize.ts`で現在のbindingへの差分だけを変換する。最新公開Workers型`5.20261114.1`も別の一時領域で取得し、V2 APIのmetadata modeを確認した。既存依存の更新は行っていない。

| 経路 | 確認した性質 |
|---|---|
| 類似検索 | Vectorize bindingへのquery。owner/video IDのfilterをJSON値として渡す |
| Vectorize応答 | physical vector IDをbridgeで固定し、metadataの自己申告IDを採用しない |
| D1本文取得 | Drizzleのパラメーター化クエリでowner、動画状態、アカウント可視性、次元数を再照合 |
| 返却直前 | 選択動画、scene revision、immutable vector IDを再確認。本文・タイトルはD1から取得 |
| インデックス更新 | 既存vectorをaddVectorsへ渡す。本文は空文字、metadataは必要な識別/フィルタ項目のみ |
| 削除・再試行 | D1 outboxとleaseで管理。遅延upsertを補償削除し、古いdeleteが新versionを削除しない |
| Embedding | 共通の既存生成処理を使用。vector storeへ渡すembedding stubは再生成要求を拒否 |

D1の業務SQL・認証・課金等はDrizzleアダプターで実装する。LangChainの汎用SQL agentや、モデルが生成したSQLを実行する経路としてD1を公開していない。LangChainのキャッシュ/メッセージ履歴のクラスを使うことは、業務データの認可・原子性を代替する条件ではない。

## 認可と入力

共有/LTIの場合は、courseのshare tokenまたはgrantを検証してownerと許可動画を決めてからRAGへ渡す。通常経路では認証したactorがcourseを取得できる必要がある。モデルがツール引数の動画選択を変えた場合も、`openSceneSearch`でcourse内の非空subsetに限定する。

Vectorizeのmetadata filterは最終認可ではない。検索providerが他人のsceneを返したり、metadataのownerを偽装した場合でもD1 joinのowner条件で拒否する。選択動画、revision、存在しないscene、動画処理中、ban/deactivationでも結果を返さない。

SQLとfilterに見える文字列は値として扱う。[D1のprepared statements仕様](https://developers.cloudflare.com/d1/worker-api/prepared-statements/)に沿って、利用者値をSQL構文として連結しない。数値の動画ID、Embedding次元/有限値/非ゼロ、limitを検証する。filterはUTF-8で2048 bytes未満に分割し、D1 bind数もchunkで制限する。

HTTPのPOSTというだけでは権限保証にならない。内部worker APIはtimestamp、method、origin、path、bodyを含む署名と操作スキーマを検証する。外部サービスとD1/Vectorizeの更新を1つのtransactionとして扱わず、冪等性・条件付き更新・outboxを使う。

## 実行した試験

ローカルworkerd D1の実マイグレーション、実際のLangChain実装、悪意ある応答を返すテスト用Vectorize bindingを使用した。追加4件:

1. SQL/filter構文に見えるowner/scene IDを渡しても、他人の取得やテーブル変更が起きない。
2. **実在する別所有者**に対し、metadataのownerが偽装されても別所有者のsceneだけを返す。
3. metadataの`vector_id`を正規IDに偽装しても、physical vector IDが違えば返さない。
4. Vectorize queryの処理中にアカウントを無効化した場合、応答後のD1確認で拒否する。

以下の5ファイル、**112 tests passed**:

```sh
cd apps/api
npx vitest run \
  test/persistence/scene-search.d1.integration.test.ts \
  test/persistence/scene-index-sync.d1.integration.test.ts \
  test/persistence/worker-internal.d1.integration.test.ts \
  test/auth-security.test.ts test/security-primitives.test.ts
```

同期試験には、削除後に到着するupsert、古いdelete、lease喪失、次元の誤fallback拒否、providerエラーの秘密値を再試行記録に残さないケースも含む。`npm run typecheck --workspace @videoq/api`も成功した。

実リモートv3 Vectorizeでの[40質問の比較](d1-automatic-query-evaluation.md)も、LangChain経由で動作した証拠となる。ただし、そちらの負例は存在しないownerであり、実在ownerの偽装は今回のローカル試験で別途確認した。

## 依存監査と限界

`npm audit --omit=dev --json`ではcritical/high/moderateは0、lowが5件。LangChain/LangSmithへの指摘は0。lowはDocusaurus→SVGR→deepmergeの同一アドバイザリ経路で、[GHSA-gcqx-w48m-w2h4](https://github.com/advisories/GHSA-gcqx-w48m-w2h4)は修正版未公開である。registryのlatestも4.3.1だった。`npm ls deepmerge --workspace @videoq/api --omit=dev --json`ではAPI依存への包含なしを確認した。監査が提示するDocusaurusの大きなversion変更を自動適用せず、ドキュメントbuild側の既知残項として記録する。

監査で未検出であることは脆弱性の不存在を保証しない。本試験は全体E2E、実OAuth、production session継承、実配置での性能、productionのsecret設定を一括して証明するものではない。特にread replicaを認可読取りへ導入する場合は、失効直後の可視性について別の検証が必要。今回の検証用D1でread replicationは無効のままである。

POSTやDB製品名だけを安全性の根拠とせず、境界ごとの検証結果として扱う。現時点でこのLangChain接続境界に越境取得を示す失敗は検出されていないが、本番移行全体の完了はまだ宣言しない。

## 関連するオンプレ実行環境の追跡

mainの上流vLLM検査で追加検出された180件も追跡した。179件はLinux CNAの一次記録・正確なheader inventory・10種類のrender済みworkload条件を照合してカーネル実装由来の適用評価を追加した。残るdnspythonの実行時依存は2.9.2をハッシュ固定のread-only volumeに追加し、実イメージで読込先/バージョンと安全な再現入力の拒否を検査した。

[実イメージ検査](https://github.com/videoq-jp/videoq/actions/runs/43615358433)の該当jobは成功し、取得したartifact 14121732864のJSONでも修正版の読込・5依存の完全一致・未評価0件を確認した。rawの640件は削除/抑制していない。[検証記録](../verification/upstream-vllm-inspection.json)に現在のCPU/import検証と過去のGPU推論検証を分けて保管した。これはD1の全体E2Eや本番移行条件を代替しない。

## チャット障害ログの追加修正

境界の追加監査で、利用枠返却失敗とSSE transport失敗のcatchが例外の`message`をログへ出していた。DBドライバーのmessageにはSQL引数が含まれ得るため、通常応答/SSEのquota cleanupとSSE writerに合成の私有診断値を注入した回帰試験3件を追加し、修正前はいずれもログへ本文が出ることを再現した。実秘密値や本番レコードを使った試験ではない。

`message-service.ts`と`routes.ts`の該当ログは固定eventと`errorType`だけにし、quota cleanupログのowner IDも除いた。HTTP/SSEへの一般化済みエラー応答は維持した。修正後は`chat-send.test.ts`、`auth-security.test.ts`、`security-primitives.test.ts`の**150件成功**、API/移行ツールの型検査成功を確認した。LangChain/Drizzle経由の処理でも、providerまたはSQL例外の本文をこのcatchからログへコピーしない。

## 実D1・Vectorize上での攻撃ケース

コミット`f60049ba255bf9e5df487808fda63ded9c89245d`の実装を使い、固定guardで合成v2だけを許可する追加試験を実行した。実データ用v3と本番は操作していない。[集約証跡](evidence/d1-langchain-live-security-2026-11-15.json)には個人情報・vector・credentialsを含めない。再現用probeと詳細診断はローカル私有領域`/tmp/videoq-retention-plan.ZLDiCA/langchain-live-security-v1/`に保管した。

合成の実在所有者2人と動画・sceneを作成し、1536次元の既定vectorを用いて、実際の`CloudflareVectorizeStore.addVectors`で5件を投入した。model呼び出しは0回。5件すべてが実インデックスから検索可能になったことを確認してから判定したため、反映前の空結果を拒否成功とは数えていない。

候補は正規scene、別所有者のsceneを要求者所有と偽装したmetadata、正規IDをmetadataへ写した偽physical ID、古いrevision、SQL構文に見えるscene ID。実際のLangChain検索からD1再照合を通すと、正規sceneのD1本文1件だけが返った。indexの偽本文は返らず、実在する他方の所有者での検索とSQL風owner文字列は0件、owner無効化後も0件だった。

最後に試験所有者/sceneを削除し、投入したphysical vector ID全件の不存在と、試験ownerをfilterしたANN検索の空結果を確認した。この結果は実サービスの検索認可境界を補強するが、768次元の同一攻撃試験、公開API認証、モデル回答全体のE2Eを実施した意味ではない。768/1536双方の通常同期・検索は別の既存staging smoke証跡に記録している。
