# 検索評価Lambdaの作成・接続確認計画

作成日: 2026-11-15。状態: ユーザー承認後、作成・合成質問1件の接続確認・停止まで完了。PR #1444はmainへマージ済みで、CI/CodeQLと[通常CD](https://github.com/videoq-jp/videoq/actions/runs/43608181148)は成功した。既存worker 3関数の更新成功を確認済み。

## 実行結果

- 専用Lambdaと7日保持のロググループを無効状態で作成した。有効化planは専用関数の更新1件のみであることを照合した。
- 初回の実行前検査は`runtime_mismatch`で停止し、invokeには進まなかった。数値Qualifier付きGetFunctionにはfunction-level Concurrencyが含まれないため、[GetFunctionConcurrency](https://docs.aws.amazon.com/lambda/latest/api/API_GetFunctionConcurrency.html)を別取得するようローカル起動クライアントを修正した。省略・無効・取得失敗時の拒否を含む既存/追加テスト84件が成功した。別のローカル準備処理でSDK clientのcontext manager使用にも失敗したが、これもinvoke前であり、停止処理は成功した。
- 公開version **2**を固定し、41 UTF-8 bytesの合成質問1件で実行成功。既存ワークロードフェデレーション認証、OpenRouterの既存モデルで1536次元の有限・非ゼロvectorを得た。入力hash、ExecutedVersion、digest、scope、vector契約は起動クライアントで照合済み。実invokeは1回、自動再試行なし。
- 終了後に予約同時実行数を**0**へ戻し、Terraformでも実行フラグ**false**へ戻した。AWS APIでActive/更新Successful、同時実行数0、フラグfalse、event source mapping 0件を確認した。公開済みversion 2もfunction-level同時実行数0により停止する。
- 出力vectorと計画/state/診断記録は私有0700/0600で保管した。CloudWatch REPORTは初回確認時には未取得のため、実請求額は未確定であり0ドルとは扱わない。
- 実質問の送信は0件。検索品質の評価、本番D1切替、既存IAM/federation trustの変更は行っていない。次は候補40件の対象範囲・正解sceneを人がレビューする段階である。

## 構成と変更範囲

| 項目 | 固定する内容 |
|---|---|
| AWS | account 257240362763 / ap-northeast-1 |
| 関数 | videoq-search-evaluation-prod |
| イメージ | videoq-worker-prod@sha256:58b667279155594a091141c2e689e3670ffaefd5c641840c44288f1b3f7355f0 |
| 元コミット | 0fb007e98adf74a4171fb26ffe0b2c57e0ee06c6 / PR #1444 |
| entrypoint | worker_python.search_evaluation_lambda.handler |
| 実行 | ARM64 / 512 MiB / timeout 300秒 / tmp 512 MiB |
| 同時実行 | 作成時0、有効化中1、確認終了後0 |
| 認証 | 既存workerロールと既存OpenRouter federation policy/audience |
| モデル | openai/text-embedding-3-small / openai profile / 1536次元 |
| 接続先 | https://openrouter.ai/api/v1 |
| ログ | 専用CloudWatch log group、7日保持。質問・token・vector・SDK応答を出さない |
| 起動 | operatorによる数値version指定の同期invokeのみ |

[独立Terraform構成](../../infra/search-evaluation/README.md)で作成する。新規2件（関数・log group）、既存更新0件、削除0件を想定する。実saved planの集計は私有領域に保管する。既存の本番infra state/CDには追加しない。Provisioned Concurrency、VPC/NAT、S3保存、Function URL、SQSや定期起動は追加しない。

ロール`videoq-worker-prod`はDB用SSM/KMS・SQSの権限も持つ。環境変数の省略は権限の剥奪ではない。mainレビュー済みdigestのコードをこの権限で実行することを、作成承認の信頼境界とする。既存federation trustやIAM権限は変更しない。実接続がinvalid_grant等で失敗した場合は停止し、APIキーへの切替やtrust拡大をしない。

## 段階と合格条件

1. **無効状態で作成**: private saved planを照合し、予約同時実行数0・enabled=falseで作成。digest/role/command/env allowlistと、既存キューへの接続なしを確認する。
2. **合成質問1件の接続確認**: 別planでenabled=true/同時実行数1とし、新しい数値versionを固定する。private targetを作り、起動クライアントで実metadataを照合後、短い合成質問1件だけを送信する。1536次元の有限・非ゼロvector、入力hash、ExecutedVersion一致を確認する。Tailログを要求しない。
3. **停止**: 成否にかかわらず予約同時実行数0へ戻し、AWS APIで確認する。応答喪失やtimeoutは結果不明として記録し、自動再試行しない。成功は認証・Embedding生成の接続確認であり検索品質の合格ではない。
4. **代表質問レビュー（別段階）**: 私有候補40件を人が確認する。元の動画選択は保存されていないため、現在のコース所属から作った範囲を承認する必要がある。過去回答の引用は正解ラベルではない。候補は4コース/78動画、明示feedbackあり4件で、引用が残る質問へ偏っている。未レビュー入力を実行manifestへ自動変換しない。
5. **品質比較（別実行）**: 正解sceneと対象scopeを凍結し、PG/Vectorize双方のRecall@20、nDCG@20、所有権拒否、遅延を同じ質問vectorで測る。提案ゲートは所有権漏れ0、Recall@20の平均差がPG比-0.02以上、nDCG@20差が-0.02以上。これは未承認の暫定値で、小標本の結果だけで一般的な品質保証としない。対象変更前に基準を確定する。

今回、実行承認を求める範囲は**1〜3の作成・合成質問1件の有料接続確認・停止**。40件の実質問送信、品質判定、本番D1切替は含めない。私有候補の確認は進められるが、人のレビュー済みとは代理判定しない。

## 費用と停止条件

2026-11-15確認の公開価格を使用。無料枠・割引を差し引かない。

- [AWS東京リージョン料金表](https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/AWSLambda/current/ap-northeast-1/index.json): ARM duration **$0.0000133334 / GB秒**、通常request **$0.0000002 / 回**。[課金概要](https://aws.amazon.com/lambda/pricing/)も参照。
- [OpenRouterモデル価格](https://openrouter.ai/openai/text-embedding-3-small/providers): **$0.02 / 100万入力token**。実行直前にモデル/価格の変更がないことを再確認する。
- 接続確認は合成質問1件、UTF-8で最大512 bytes、同期invoke **最大1回**、自動再試行なし。duration 300秒なら0.5×300×単価 = **$0.00200001**。入力512 tokenと保守的に見積もるモデル料は**$0.00001024**。初期化時間・ログ・転送・税等は別で、上記は請求総額の保証上限ではない。
- 今回の**運用予算上限は$1（税別）を提案**する。これはAWS/OpenRouterの自動強制停止設定ではない。実行数1回と入力長を制限し、異常時に再実行せず同時実行数0へ戻す。既存本番policyの共有利用へ新しい支出制限は設定しない。
- 将来の40質問は重複排除して最大3invoke（16/16/8）。同じvectorを性能反復へ再利用する。各質問8000文字の現行validator上限からUTF-8最大128万bytesを置くと、token数の保守的なbytes換算でモデル料約$0.0256、Lambda 3回×300秒で約$0.006。実際にはモデルの8K context内へtoken数を確認して収める。現在はこの段階を実行しない。

失敗時の再送、モデル変更、IAM/trust変更、費用拡大はこの計画に含めず、原因と具体的差分を確認する。接続確認結果はprivate 0700/0600へ保管し、公開記録には件数・成否・固定診断codeだけを残す。

## 検証と残る制約

Terraformのfmt/validate、diff whitespace checkが成功した。実saved planの全actionを機械照合し、関数とlog groupの**作成2件・更新0件・削除0件**、実行フラグfalse/予約同時実行数0、固定digest/role/env allowlist一致を確認した。評価生成・隔離handler・私有クライアントの既存テスト**79件成功**。専用関数・log groupの不存在、既存モデル設定の一致もAWS APIで確認した。

saved planと集計はローカル私有領域`/tmp/videoq-retention-plan.ZLDiCA/search-evaluation-plan/`に保管した。作成前planだけではoperatorのCreate/PassRole/Invoke権限やOpenRouterでの認証成功は保証できないため、上記の実行結果を別途記録した。production D1 cutoverは未実施。
