# 隔離した検索評価Lambdaの実行境界

## 現在の状態

`worker_python.search_evaluation_lambda.handler`は、既存のワークロード用フェデレーション認証でEmbeddingだけを生成する専用エントリーポイントである。通常の`handler.handler`やSQSジョブには接続していない。関数作成、IAM変更、認証policy変更、実モデル呼び出しはまだ行っていない。

このコードをmainへ取り込む場合、通常のCDでworkerイメージへ同梱されるが、既定のhandler・既存関数設定・SQS配送先は変更しない。実行には、レビュー済みイメージの不変digestと、このエントリーポイントを選択した隔離関数が必要になる。

## 予定する実行構成

- 名前は既存workerと異なる評価専用関数とし、Function URL・SQS・schedulerは接続しない。
- 既存のフェデレーション主体を維持する案では、既存worker用ロールを使用する。これはDB用SSMやSQSの権限も持つロールであるため、コードのレビューは権限の信頼境界になる。ローカル運用者がそのロールをassumeする方式ではない。
- 専用関数へ渡す設定は、現在のEmbeddingモデル・profile・endpoint・OpenRouter policy/audienceと、明示的な`VIDEOQ_SEARCH_EVALUATION_ENABLED=true`だけとする。DB/APP parameter名、DB URL、APIキーをコピーしない。
- 作成・起動権限は別途operator管理とし、既存のGitHub roleの許可範囲を広げない。新しい関数の作成や実行は、このコード追加だけでは承認・実施されない。
- ARM64、メモリ512 MiB、timeout 300秒、専用の同時実行上限1を想定する。実リソースのplanと費用確認は、レビュー済みイメージのdigestが確定してから行う。

## 入出力契約

同期invokeは、公開した数値versionを指定し、`RequestResponse`で行う。質問と応答のベクトルは私有データとして扱い、`LogType: Tail`やGitHub標準出力への応答出力は使用しない。

```json
{
  "version": 1,
  "operation": "prepare_query_embeddings",
  "manifest": {
    "version": 1,
    "cohort": "production-rehearsal",
    "corpusSha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    "embedding": {
      "provider": "openai",
      "model": "openai/text-embedding-3-small",
      "profile": "openai",
      "dimensions": 1536,
      "baseUrl": "https://openrouter.ai/api/v1",
      "authentication": "workload-federation"
    },
    "samples": 1,
    "cases": [{"id":"synthetic-q1","question":"形式確認用の合成質問です","userId":"synthetic-owner","videoIds":[1],"limit":20}]
  }
}
```

これは形式説明用の合成例である。source archiveの照合、代表質問・正解ラベル・閾値の確定は別途必要になる。

- 有効化フラグの既定値は無効。環境変数・command・role・SQS Records等の追加引数は拒否する。
- 1回最大16ケース、manifest最大1 MiB。case/scope等は既存の私有入力validatorで検証する。大きな質問セットを使うclient側の分割・結果照合はまだ未接続である。
- `authentication`は`workload-federation`に限定する。入力に書いたモデルやendpointへ設定を切り替えることはなく、現在の環境と違えば通信前に拒否する。
- 実行残時間が240秒未満なら通信前に拒否する。モデル障害やtimeoutでは、成功した部分結果を公開せず、呼び出し元が状態を確認する。モデル呼び出し後の失敗には費用が発生し得る。
- 質問・中間生成物は実行ごとの0700ディレクトリと0600ファイルへ置き、通常の成功・失敗時に削除する。DB秘密情報のbootstrap、DB接続、SQS操作は呼び出さない。
- 成功時は`evaluation_input`、入力manifestのハッシュ、件数等を返す。質問本文・認証情報は返さない。応答が4 MiBを超えた場合はベクトルを返さず失敗とする。
- 失敗時は固定の診断codeだけを返し、SDK例外や原因情報をログへ流さない。AWS実行環境による強制終了を含む障害復旧は、実環境で別途確認する。

私有入力の形式と既存モデル設定の照合は[Embedding準備ツールの手順](d1-representative-query-preparation.md)を参照する。この実行経路のコード試験は、実OpenRouter接続やD1切り替えの合格を意味しない。
