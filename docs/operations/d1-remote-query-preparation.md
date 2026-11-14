# 評価専用Lambdaの私有起動クライアント

`python -m worker_python.remote_search_evaluation`は、レビュー後に作成する評価専用関数へ質問を送り、返却されたベクトルを既存のPG/D1比較入力へまとめる。現時点では実関数への接続・モデル呼び出しを行っていない。PR #1444のマージ承認、専用関数の作成、起動権限の設定は別途必要になる。

## 固定するtarget

質問manifestと同様に、target JSONも所有者の0700ディレクトリ内の0600通常ファイルへ置く。以下は形式説明用の**合成値**であり、実際の関数・イメージではない。値は承認・作成した実リソースの不変versionとdigestが確定してから記録する。

```json
{
  "version": 1,
  "functionArn": "arn:aws:lambda:ap-northeast-1:111122223333:function:videoq-search-evaluation-prod",
  "functionVersion": "7",
  "imageUri": "111122223333.dkr.ecr.ap-northeast-1.amazonaws.com/videoq-worker-prod@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  "roleArn": "arn:aws:iam::111122223333:role/videoq-worker-prod",
  "federationPolicyId": "synthetic-policy"
}
```

専用関数名、東京region、同じaccountのworker repositoryとroleを要求する。`$LATEST`、alias、可変image tag、通常のSQS worker関数は拒否する。

## 実行前の確認

```sh
python -m worker_python.remote_search_evaluation \
  --input /private/evaluation/questions.json \
  --target /private/evaluation/target.json \
  --output /private/evaluation/frozen-vectors.json
```

既定ではローカル入力だけを確認し、AWS SDKの読み込み・認証解決・AWS通信を行わない。`target_verified: false`を返し、未作成のtargetを存在確認済みとは扱わない。出力ファイルも作成しない。

実リソースの作成・モデル送信が承認された実行環境でのみ`--execute`を追加する。既存operatorのGetFunction/Invoke権限を使用し、profileによるAssumeRole・web identity・credential processの取得経路はSDKから除く。workerのSSO role指定も拒否する。実行コード自体にIAM許可の付与やフェデレーションpolicy変更はない。

実行前に、指定した数値versionのGetFunction応答を照合する。

- function ARN/version、role、解決済みimage digest、Active/更新成功状態。
- 専用handler、ARM64、512 MiB、timeout 300秒、予約同時実行数1。
- 有効化フラグ、モデル・profile・次元数・endpoint、OpenRouter policy/audience。
- 環境変数は評価用allowlistのみ。DB/APP parameter名、DB URL、APIキー等がある構成は拒否する。

AWS endpointは東京のLambda APIへ固定し、SDKの試行回数は1回とする。実行は[同期Invoke](https://docs.aws.amazon.com/boto3/latest/reference/services/lambda/client/invoke.html)を数値Qualifier付きで呼び、Tailログを要求しない。

## 結果の照合と保管

質問本文を全ケースで重複排除し、初出順に最大16質問ずつ送る。同じ質問の異なる所有者・動画選択・性能反復では生成ベクトルを再利用する。case全体の順序と検索範囲は元manifestから再構成する。

各応答について、ExecutedVersion、status、入力manifestのハッシュ、corpus/model/dimensions、case IDの順序、所有者・動画選択・limit、およびベクトルの数値・次元数を検証する。全バッチが一致した場合だけ、元の全ケースとsample数を持つ0600ファイルを原子的に公開する。出力には質問本文を含めず、元manifestハッシュ、case ID順序と実行version/digestを残す。

出力ごとの排他と上書き拒否を使用する。失敗や応答喪失時は自動再試行せず、不完全な評価ファイルを公開しない。応答喪失の前にモデル処理が完了している可能性はあるため、再実行には費用が重複し得る。現段階では途中再開機構は持たない。

入力や例外、SDK応答は標準出力へ表示しない。公開する診断は固定codeと件数だけとする。生成成功は実モデルとの接続・入力作成の確認であり、正解ラベルに対する検索品質の合格ではない。後続手順は[代表質問Embedding準備](d1-representative-query-preparation.md)を参照する。
