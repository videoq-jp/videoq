# D1シーンの検索反映と動画完了

Vectorize V2のmutation受付はANN検索への反映完了を保証しない。実サービスの個別観測では、受付後の最初の認可済みhitまで約23秒・130秒かかった。固定sleepを完了条件にはしない。

## 状態遷移

- `scene_index_tasks.accepted_at`はLangChain経由のupsert受付を記録する。この時点でD1のEmbedding payloadを消す。
- 受付済みタスクの再試行ではupsertを繰り返さず、実インデックスの`queryById`で確認する。
- owner、video、immutable vector IDをfilterに含め、physical ID、scene ID、revision、metadata、有限のscoreが一致した場合にだけ`completed_at`を記録する。
- 応答が空・不正・例外の場合は`VECTORIZE_NOT_READY`として再試行する。確認間隔は最大60秒とし、時間経過を成功条件には使わない。
- runの`pending_vectors`はpublication時に集計し、leaseを保持する完了処理だけが原子的に減らす。最後の完了と同じD1バッチで、既存Workerへ動画完了を再確認するジョブをOutboxに記録する。
- `index_video_transcript`による`indexing`から`completed`への遷移では、current source/file/headと全シーンの受付・検索反映を再検査する。カウンターやVectorize metadataだけで完了・認可を決めない。

既存のバックグラウンド再インデックスがメディアstatusを維持する契約は変更しない。`completed`だけを、すべてのバックグラウンド処理や検索品質の合格根拠にはしない。

upsert応答後の削除確認は、受付の記録やlease喪失による終了より先に行う。期限切れleaseの後継処理が動画とvectorを削除済みでも、遅延した旧upsertが戻ったときの補償削除を省略しない。

`queryById`による確認はD1用アダプター内に閉じる。検索・登録・削除には引き続き実際の`CloudflareVectorizeStore`を使用し、Embedding生成は既存の共通処理を維持する。PostgreSQLの実装・履歴は変更しない。

## インデックスの事前条件

768／1536次元の各インデックスに、次のmetadata indexが必要。

| property | type |
| --- | --- |
| `user_id` | `string` |
| `video_id` | `number` |
| `vector_id` | `string` |

immutable vector IDは64文字のSHA-256 hexであり、string indexの64-byte上限内に収まる。同じEmbeddingを持つ複数シーンでもIDで対象を限定する。

[Cloudflareの仕様](https://developers.cloudflare.com/vectorize/reference/metadata-filtering/)ではmetadata indexは後付けで既存vectorへ反映されない。インデックス作成mutationの処理完了を確認してから投入する。既存データを更新する場合は、作成後の再upsertが必要。

## `0019_scene_search_readiness`の適用

本番D1切り替えとは別の変更である。既存D1を更新する場合は、バックアップと復旧手段を確保し、旧バージョンの同期Worker・キュー処理を停止してから適用する。metadata indexの準備、D1マイグレーション、新実装の配備を完了した後に処理を再開する。

移行は過去のupsert完了を受付履歴として盲信せず、未反映数を再構築し、対象動画を`indexing`へ戻す。payload消去済みのタスクは、physical ID・所有者・動画・scene・revisionが一致する保存済みvectorを再利用する。格納済みfloat32値を保持し、モデルを再実行しない。保存済みvectorが欠損・不整合の場合は完了させず、既存のsource再構築ジョブへ渡す。この障害経路では通常の再Embeddingが必要になり得る。

移行CLIの`deliver`は`pending_tasks`が残る場合に終了2を返す。再試行後、既存の全件照合と検索品質試験を実行する。移行履歴の既存SQLを修正したり、旧Workerと新Workerを同時に同期させたりしない。

## 検証範囲

ローカルの実workerd D1で、反映待ち、複数シーン、再投入防止、lease、source変更、旧payload再開、欠損・metadata不整合からの再構築、完了とOutboxの原子性を検証する。実Cloudflareでのアダプター試験は、専用の一時D1・両次元インデックスを使い、既存v2/v3や本番を更新しない。

この仕組みの成功は、LLM回答を含むクラウド全体E2E、検索レイテンシ改善、料金受入、外部OAuth・本番cookie継承、D1書き込み後のNeonへの切り戻しを代替しない。

最新の実アダプター試験は[集約証跡](evidence/d1-scene-readiness-adapter-2026-11-15.json)に記録する。768／1536次元の4合成シーンで反映待ち、旧タスク再開、完了ジョブ重複防止、別owner拒否が成功し、一時リソースの削除も一覧で確認した。PostgreSQL 17.11を含む4ファイル90試験、lease・旧スキーマ更新を含む対象4ファイル37試験も成功した。既定並列度の全体試験では3件が時間制限に達したため、その失敗を記録した上で対象3ファイル28試験を再実行し、すべて成功した。さらに並列数を2に抑えた全体試験は219ファイル・2401試験成功、115ファイル・1441試験skipとなった。変更後コミットのCI結果とは区別する。
