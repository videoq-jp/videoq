# 本番停止中の最終データ移送とWorker内部認証

この手順は本番切り替えの準備部分だけを扱う。API再開・SQS再開・保守排他の解除を行わない。本番書き込み停止後に取得した完全バックアップを使用する。

`cutover-transfer.mjs`はローカルのクリーンなレビュー済みmain履歴から実行する。固定AWSアカウント、所有中のcutover-hold、停止済みAPI・3コンシューマー・デプロイ、PostgreSQLログインフェンス、フェンス後の成功済みネイティブバックアップを再確認する。DB管理認証情報は読み取らない。

対象は`videoq-d1-migration-staging-v4`、既存のv3 Vectorize二インデックス、`videoq-media-prod`。D1スキーマ適用後、`--mode import`、`deliver`、`verify`を順に実行する。各呼び出しには`--run`、`--source`、`--input`を指定する。入力ファイルとアーカイブ全体のSHA・サイズを、固定S3バージョンに紐づく最終バックアップ証跡と照合する。共通テーブルだけでなくチェックポイント、シーン、視覚データ、シーケンスの移送完了を必須とする。

R2の読み元と書き先は同じバケットだが、書き込みは新規UUIDを含む`.visual-v2`の不変キーに限定する。元の動画・旧視覚オブジェクトを上書きしない。Vectorizeの空き容量確保と既存オフラインインデックスの内容確認は、このコマンドの前に別途必要。検証済みデータを保護するため、稼働中D1への再インポートは拒否する。

`enable_cutover_final_handoff`は既定false。復旧・D1 smoke両機能も有効である場合だけ有効化できる。AWSの固定rotationプロジェクトで`cutover-internal-auth`を実行すると、移送検証証跡と停止状態を確認した後、既存の有効な内部API共有鍵を引き継ぐ。未設定の場合はAWS内でのみ新規生成し、固定SSMパラメーターに保存する。APPの未知フィールド・利用者の認証/暗号鍵とWorkerのその他のバインディングを保持する。既に存在する未所有のWorker共有鍵は上書きしない。

途中失敗時は停止・フェンス・保守排他を維持する。DB変更開始マーカーをfalseへ戻したり、従来の切り替え前解除手順で解除してはならない。切り替え後のE2E成功証跡と明示的な完了手順が別途必要。

検証: 共通契約テスト、実SQLite/D1既存契約、同一R2バケットを使うworkerd統合テスト、ネイティブバックアップ証跡/失敗応答/所有権競合を扱う合成トランスポートテスト、実オペレーターZIPの組み込み依存だけによる認証stageロード、Terraformモックplan。これらは実本番切り替え・復旧の成功を意味しない。

実データの読み取り検証では、既存の隔離v3 D1の視覚run 5件・chunk 10件を読み、隔離R2の不変オブジェクトから本番R2の旧互換オブジェクトを照合した。作成が必要な出力はメモリ内だけに保存し、実R2には一切書き込まず、全件の復旧互換性検証が成功した（2026-11-16）。これは現時点の視覚データに関する検証であり、将来の更新後の無条件ロールバック保証ではない。

Worker管理用の短期トークンは`VIDEOQ_CUTOVER_CONTROL_TOKEN`で与えられる。WranglerのリモートR2/D1/Vectorize接続には既存CLI OAuth認証を使用でき、管理用トークンの権限を広げる必要はない。CLI OAuthの期限更新が必要な場合はWrangler標準の更新処理を使用する。

## 本番バックエンドの引き継ぎ

`run-cutover-backend.cjs --run <所有中run> --source <レビュー済みSHA>`は全て停止したまま、固定3 Lambdaの環境だけをRevisionId条件付きで更新し、既存のSSM参照・モデル・キュー設定を維持する。クラウドD1用の内部API経路を選択するため、残したDB_PARAM_NAMEはworker bootstrapが読み込まない。コードSHAが変わった場合は停止する。APIの共有鍵は既存バインディングを継承し、Hyperdriveと移行用PostgreSQLフォールバックを除去して固定D1・Vectorizeへ切り替える。元の非秘密設定・変更意図・完了状態を保守runへ先に記録する。ローカルへのDB管理資格情報の取り出しは行わない。

再開前に、mainの本番Wrangler設定が同じD1・Vectorizeを指定し、Neonローテーションの定期実行がDISABLEDであることを必須とする。切り替え用sourceはクリーンなレビュー済みmain履歴上のSHAに固定する。mainが先へ進んだ場合も現在のmain設定を検証し、オンプレミスのPostgreSQL設定は変更しない。

`run-cutover-finalize.cjs --action resume --run <run> --source <SHA>`はネイティブバックアップ、ログインフェンス、所有権、固定Worker revision/code/env、D1バインディングとmain設定を確認する。再開意図を保存してからAPIを再開し、/ready成功後に元々有効だったSQSマッピングだけを戻す。まだ保守排他を解除しない。

続いて固定AWS smokeジョブをAI回答検証ありで実行する。`--action complete`には`--smoke-build`と`--smoke-run`も渡す。成功済みの固定AWSプロジェクト、同一のレビュー済みオペレーターバージョン・source、再開後の開始時刻、AI検証フラグを照合する。APIと全Workerのrevisionはこの間変わっていてはならない。成功後に元のデプロイ受付状態を戻し、`postwrite-complete`と完了証跡を記録する。Step Functionsが条件付きトランザクションでこのrunの排他だけを解除する。`database_mutations_started=true`とPostgreSQLのNOLOGINを保持し、切り替え前の解除処理を再利用しない。

失敗時は成功証跡や解除を記録しない。再開後の異常では、所有中の保守runの下でAPI/SQSを再停止して復旧する。D1からの変更の再適用や停止復旧を伴わない単純なNeon接続切り戻しは禁止する。
