# D1・Vectorizeの通常復旧

現行クラウド版はD1を正本とし、Vectorizeは再生成可能な検索索引として扱う。旧Neonと27個の旧Django/OAuthテーブルは復旧対象外。2026-11-17にWorkers Paidへ変更し、無料枠の日次読み取り上限で止まったD1クエリと本番処理smokeの回復を確認した。基本料金は月額5米ドル、含まれる枠を超えた利用は別途課金される。

## D1を戻す場合

[Time Travel](https://developers.cloudflare.com/d1/reference/time-travel/)は自動で有効であり、Workers Paidでの履歴保持は30日。対象アカウントの契約と必要な復旧時点のbookmarkを実行時に確認する。保持期間外、アカウント喪失、Cloudflare自体を利用できない事象をこの方式で復旧できるとは扱わない。

1. 対象DB UUID、Worker binding、適用済みマイグレーション、bookmarkと障害時刻を確認する。DB名に`staging`が含まれていても本番の場合がある。
2. アップロード受付、内部API、全Lambda/SQS consumer、再試行、Outbox、定期処理を含むwriterを停止し、進行中の処理が収束したことを確認する。停止中のイベントと外部副作用を記録する。
3. 復旧前bookmarkを取得する。Time Travelは対象DBをその場で上書きするため、通常の検証で本番にrestoreを実行しない。復旧先と時点を再確認して実行する。
4. foreign_key_check、所有関係、認証・課金・利用枠・ジョブ状態を検証する。復旧時点以降の外部課金、メール、R2、SQS、Durable ObjectsはD1と一緒には巻き戻らない。重複・削除・欠損を照合してから再開する。
5. Vectorizeを復旧後のD1に整合させる。古い索引に残るIDがD1で不可視でも認可を通さないという防御は維持するが、正常な再構築の代わりにはしない。

[実Lambda/SQSを含む隔離Time Travel復旧試験](d1-lambda-time-travel-recovery.md)の範囲と制限も参照する。小規模な隔離試験は全本番writer停止や本番RTOの実証ではない。

## Vectorizeを再構築する場合

`infra/scripts/rebuild_scene_vectors.py`は信頼できる新しいD1 SQLエクスポートをオフライン検証し、`scenes.content`を既存モデルで再Embeddingする。既存Vectorize値やS3移行バックアップは入力にしない。出力は正しい所有者・動画・シーン・revision・既存vector IDを維持したNDJSONである。

```sh
umask 077
mkdir -m 700 /private/recovery
# Wranglerの認証済みoperatorで対象UUID/bindingを確認し、新しいD1 exportを取得する。
# ファイルは /private/recovery/current.sql に保存し、chmod 600する。
mkdir -m 700 /private/recovery/generated
python3 infra/scripts/rebuild_scene_vectors.py \
  --source-sql /private/recovery/current.sql \
  --output-dir /private/recovery/generated
```

準備だけではAWSやモデルを呼ばない。実行時は[独立評価Lambda](../../infra/search-evaluation/README.md)を短時間だけ有効にする。対象digestがECRに存在し、レビュー済みの固定entrypointであること、DB/SSM/R2の環境変数がないことを確認する。数値version・image・role・既存フェデレーションpolicyを固定した私有target JSONを作成し、`--target /private/recovery/target.json --execute`を追加する。モデル費用が発生し、応答を失った呼び出しは自動再試行しない。処理終了・失敗時ともreserved concurrencyを0にし、フラグもfalseへ戻す。

このツールは現行の1536次元`openai/text-embedding-3-small`専用。OpenAI profileはquery/documentで同一入力を送るため既存の評価entrypointを利用できる。768次元などのprefix付きprofileは拒否し、対応したdocument embedderを用意する。異なるモデルを同じ索引へ混在させない。

再構築手順は次のとおり。

1. 復旧時点のD1を確定し、対象シーンの本文・ID・revision・所有関係を検証する。稼働中データで試験する場合は生成前後の同一性を確認する。
2. 新しい専用Vectorize indexを同じdimensions/metricで作成し、`user_id`（string）、`video_id`（number）、`vector_id`（string）のmetadata indexを**投入前**に作成する。既存本番indexは上書きしない。
3. 私有NDJSONをWranglerでupsertし、非同期反映を待つ。getByIdsは20 ID以下に分割して全件のID・metadata・値を照合する。
4. 代表クエリで所有範囲・動画範囲、件数、top-K、スコアを確認する。比較元が使えない災害復旧では保存済みの非機密な評価基準も使う。シーン本文の自己検索だけを人間の質問に対するRAG品質評価と呼ばない。
5. binding切り替えは別のレビュー済みデプロイで行う。再開前に差分と削除を処理し、アップロードから出典付き回答まで確認する。切り替え前のindexは必要な確認後に撤去する。
6. 検証用index、生成NDJSON、SQL、本文inventory、Lambda応答を削除する。公開リポジトリやCI artifactへ本文・ベクトル・トークンを保存しない。件数・ハッシュ・集計結果のみ記録する。

D1・Vectorizeの更新は単一トランザクションではない。通常運用のOutbox/retry/照合を継続し、再構築中の更新を失わないことを確認する。復旧に必要な時間とEmbedding費用はデータ量とモデルの利用可能性に依存する。

## 2026-11-17の実証結果と保存方針

[集計証跡](evidence/d1-vectorize-reconstruction-2026-11-17.json)。本番を上書きせず、新しいD1 exportをオフラインSQLiteへ復元し、integrity/FK検査を通過した。全2,190シーン・80動画が本番D1の本文・所有関係・revisionと一致した。同じ1536次元モデルをフェデレーション経由で呼び、本文から新しいベクトルを生成した。768次元の現行データは0件であり、そのprofileの再生成を実証したものではない。

隔離indexで全ID・metadataと生成値のreadbackを照合した。既存値とのコサイン類似度は平均0.9999389、最小0.9951647であり、バイト単位の再現は保証しない。最初の点単位0.9999という診断閾値は満たさなかったため、これを合格扱いせず、過去の評価で固定済みの検索品質基準を追加で適用した。80動画それぞれの自己検索top 5の集合は全件一致し、順序も79件で一致した。

過去の評価用質問40件（AI判定対象30件・診断10件）と別所有者40件について、固定した既存query embeddingで本番indexと再構築indexを同条件比較した。top 20の平均一致率は99.75%、AI候補Recallの差は0、候補nDCGの差は+0.0001872、別所有者へのヒットは0。以前に固定した「平均一致率98%以上・Recall/nDCG差とも-0.02以上・別所有者ヒット0」の基準を満たした。これは非網羅のAI候補ラベルによる比較であり、人間の正解判定、回答生成の再評価、全質問への一般化を主張しない。

Paid変更後のネイティブAWS処理smokeも成功した。この再実行は`verify_ai_answers=false`であり、過去のAI回答付きE2Eの代わりには数えない。今回、本番Time Travel restoreやVectorize binding切り替えは実施していない。

この確認後、所有者が不要としたS3のD1 SQL・scene vector・移行manifestの3バージョン（246,051,498 bytes）をVersionId指定で削除し、保存済みバージョン0・delete marker 0を確認した。旧Neonアーカイブは先に廃棄済み。空のS3 bucketの公開防止・暗号化設定は維持し、新規の定期バックアップ保存は有効にしない。復旧コード・手順・集計証跡は残す。

隔離indexを削除し、評価Lambdaはフラグfalse・reserved concurrency 0へ戻した。ローカルのSQL・SQLite・本文inventory・生成ベクトル・評価応答も削除する。保持する通常復旧方式はD1 Time TravelとVectorize再生成であり、独立した長期データコピーを残す方式ではない。
