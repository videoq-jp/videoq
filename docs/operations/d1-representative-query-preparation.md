# 代表質問からの評価用Embedding生成

このツールは、同じ質問ベクトルをPostgreSQLとD1/Vectorizeの検索へ渡すための私有入力を生成する。既存のPython `embed_texts(..., input_type="query")`と現在のモデル設定を使用する。DB・キューへ接続せず、モデル・認証設定も変更しない。

2026-11-14時点では、接続済みの検証環境は未確認で、本番はOpenRouterフェデレーション認証を使用している。現在の運用者IDによる交換は失敗している。このツールを追加しただけでは、運用者IDで本番の認証権限を取得できるようにはならない。既存ワークロードへの配布・隔離実行のレビューと接続確認は残る。実モデル呼び出しと代表質問の品質評価は未実行である。

## 入力と保管

入力JSONと出力先の親ディレクトリは、実行ユーザーが所有する0700ディレクトリにする。入力ファイルは0600の通常ファイルとし、シンボリックリンクは拒否する。既存の出力は上書きしない。質問・所有者・動画の選択・期待する正解シーンは私有データとして管理する。

以下は形式説明用の**合成例**であり、実際の移行データや評価セットではない。`corpusSha256`は検証済みarchiveのSHA-256へ置き換える。model/profile/dimensions/baseUrl/authenticationは、実行ワークロードの既存設定と一致させる。不一致はモデルを呼ぶ前に拒否する。

```json
{
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
  "samples": 3,
  "cases": [
    {
      "id": "question-001",
      "question": "合成動画で紹介した手順は何ですか？",
      "userId": "synthetic-owner",
      "videoIds": [1],
      "limit": 20
    }
  ]
}
```

- case IDは一意の英数字・`_`・`-`で64文字以内とする。質問は空白だけの値を拒否し、最大8,000文字。送信時に質問本文を書き換えない。
- caseは最大1,000件、入力は2 MiB以内。limitは1〜50、samplesは1〜30。samplesは検索の反復回数であり、Embeddingを繰り返し生成する回数ではない。
- 同一の質問本文は、所有者や動画の選択が違っても一度だけ生成する。最大16質問ずつ既存関数へ渡す。自動再試行は行わない。
- `authentication: "workload-federation"`では、既存のOpenRouter policyとAWS region設定を確認する。資格情報は既存のワークロード認証経路で取得し、manifest・引数・出力に含めない。
- `authentication: "configured"`はオンプレ等の既存の設定済み認証用。768次元の`embeddinggemma2`も、そのプロファイルの現在のモデルと専用endpointに一致する場合だけ使用できる。

## 実行

既存の設定を持つ実行環境で、インストール済みworker packageから呼び出せる。

```sh
python -m worker_python.search_evaluation \
  --input /private/evaluation/questions.json \
  --output /private/evaluation/frozen-vectors.json
```

既定ではファイル・構成だけを検査し、トークン交換もモデル通信も行わない。成功時の標準出力は件数・次元数と`model_calls_made: false`を含む集約JSONで、ファイルは生成しない。リポジトリからは`python apps/worker/scripts/prepare_search_evaluation.py`でも同じ引数を使用できる。

モデルへの質問送信と費用を伴う実行では、同じコマンドに`--execute`を追加する。フェデレーション設定・IAM信頼関係を変更する処理は含まない。現在の運用者IDでこの実行を再試行しても、未確認の実行経路の代わりにはならない。

生成中は出力ごとの排他ファイルを保持し、全バッチ・全ベクトルの検証成功後に0600ファイルを原子的に公開する。後から別の出力が作成されても上書きしない。通常の失敗では一時ファイルと排他ファイルを削除し、不完全なベクトルセットを公開しない。プロセスの強制終了で排他ファイルが残った場合は、その実行が終了していることを確認してから扱う。途中失敗した場合でも、それまでのモデル呼び出しの費用は発生し得る。

## 検索評価への接続

出力は既存の`SearchEvaluationInput`形式で、元の質問本文を含めない。case IDの順序、入力manifestの正規化ハッシュ、モデル構成を`generation`へ記録する。出力も所有者・動画・ベクトルを含む私有データとして保管する。

検証済みのoffline PostgreSQLコピーの接続と同じEmbedding構成を事前設定した評価環境では、既存コマンドへ渡せる。

```sh
PERSISTENCE_EVALUATION_SOURCE_OFFLINE=1 \
  npm run db:d1:staging:evaluate-search --workspace @videoq/api -- \
  --input /private/evaluation/frozen-vectors.json \
  --archive /private/evaluation/current-app.videoq-export.ndjson \
  --output /private/evaluation/search-report.json
```

旧27テーブルを保全対象として除外したarchiveでは、既存手順どおり`--preserved-policy`と`--backup-dir`も指定する。検索コマンドはarchive、source snapshot、target vector配信を照合する。Embedding生成ツール自体はarchive本体を照合しない。

生成成功はモデル接続と入力作成の証拠であり、検索品質の合格ではない。検索コマンドのPG/D1一致率も、人が正解としたシーンに対するRecallではない。代表性の確認、正解ラベルと閾値の合意、実検索・認可・E2Eによる確認が済むまで、品質と本番切り替えの条件は未達とする。
