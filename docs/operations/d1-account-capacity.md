# アカウント全体の容量・利用量確認

2026-11-16 JST。検証用v3だけを対象にした従来の試算を補い、Cloudflareアカウント全体の共有枠と直近30日の利用集計を読み取りで取得した。対象期間は2026-10-17〜2026-11-15の完了済みUTC日であり、進行中の11月16日は含めない。[集約証跡](evidence/d1-account-capacity-2026-11-16.json)。契約プランは確認済み。本番移行後の通常/ピーク予測・予算受け入れは未完了であり、本番切り替え条件を解除する結果ではない。

## 現在の容量

RESTの一覧を末尾まで取得し、各Vectorize indexのinfoと次元数を照合した。顧客の本文・質問・ベクトル本体・秘密情報は取得していない。

| アカウント全体の対象 | 実測 |
|---|---:|
| D1 DB数 | 3 |
| D1合計容量 | 111,468,544 bytes |
| 最大のD1 DB | 109,314,048 bytes |
| Vectorize index数 | 6 |
| 保存vector数 | 2,194 |
| 保存vector次元数の合計 | 3,368,448 |

全DBと全indexを含む現在量は、FreeのD1 1DBあたり500 MB・アカウント合計5 GB、Vectorize保存5,000,000次元以内だった。Paidの上限/包含量も適合する。ただし、これを現在の契約がFreeである証拠とは扱わない。[D1制限](https://developers.cloudflare.com/d1/platform/limits/)、[D1料金](https://developers.cloudflare.com/d1/platform/pricing/)、[Vectorize料金](https://developers.cloudflare.com/vectorize/platform/pricing/)。過去の検証用indexを、この確認のために削除・変更していない。

## 30日の利用集計

GraphQLのアカウントfilterのみでD1、Workers、Vectorize V2を取得し、製品内の特定DB/indexだけに限定しなかった。Workersはscript別の集計も取得し、合計がアカウント集計と一致することを確認した。以下はAnalyticsの集計であり、確定請求額・完全な請求明細ではない。

| 指標 | 期間合計 | 最大の1日 |
|---|---:|---:|
| Workers requests | 78,830 | 20,030 |
| Workers CPU | 606,648.29 ms | 87,851.34 ms |
| D1 rows read | 4,405,664 | 2,613,991 |
| D1 rows written | 93,139 | 46,266 |
| Vectorize queried dimensions | 6,134,784 | 4,710,912 |

Workersは30日分、D1とVectorizeのquery集計は11月13〜15日の3日分が返った。D1/Vectorizeは移行・検証を含む期間であり、3日分の中央値を本番の通常負荷と呼ばない。D1の記録はSQL実行まで到達したリクエストであり、集計がない日を全リクエスト成功の証拠としない。[D1 Analyticsの範囲](https://developers.cloudflare.com/d1/observability/metrics-analytics/)。

本番APIのWorkers集計は30日で11,790 requests、1日中央値270、最大1,490だった。HTTP route別・認証済み業務操作別の割合は、このdatasetからは確認していない。したがって、全APIリクエスト数をRAG質問数やD1 query数へ置き換える予測はしない。

観測したD1の最大日はFreeのread 5,000,000/day・write 100,000/day以内だった。ただし、この検証負荷の結果から本番のピークも同じとは判断しない。Paidではread 25,000,000,000/month・write 50,000,000/monthが包含される。共有枠、index更新による追加write、再試行や成長を含めて最終候補で評価する。[D1料金](https://developers.cloudflare.com/d1/platform/pricing/)。

## 比較可能な費用シナリオ

現在の全indexの保存量を固定し、アカウント全体で1536次元のindex検索を月100,000回行う仮定では、公開式によるqueried dimensionsは156,968,448。Paid包含50,000,000次元を差し引いたquery超過分は約$1.07/month、現在の保存次元数による保存超過分は$0となる。これは実トラフィック予測ではなく、指定した回数に対する条件付きの試算である。[Vectorizeの計算式と単価](https://developers.cloudflare.com/vectorize/platform/pricing/)。

1つのRAG質問が複数のindex検索へ分かれる場合、その呼出し回数をすべて数える。質問100,000件とindex検索100,000回を同じものとしない。Workersの基本料金・CPU/requests、R2、LLM/Embedding、AWS、バックアップ、移行中の重複稼働はこの$1.07に含めない。また、30日の観測値は請求周期の残枠ではない。

## 契約と予算の残件

2026-11-16 05:30 UTCに、許可された新規ブラウザーで請求のサブスクリプション画面を読み取り確認した。Workers Freeがアクティブで、Workers Paidはアップグレード候補だった。R2はPaidで次回更新日は2026-11-20だった。この更新日をD1・Vectorizeの無料枠のリセット日とは扱わない。subscriptions APIは既存OAuth権限で403だった。権限追加・プラン変更・購入は行っていない。個人の支払情報は証跡へ保存していない。

月100,000回のindex検索シナリオは、現契約のVectorize無料枠30,000,000 queried dimensions/monthを超える。約$1.07はPaidを仮定した超過額であり、現契約で自動的に従量課金して継続できるという意味ではない。実負荷予測がFree枠を超える場合は、切り替え前にプランと総予算の受け入れを確定する。

AWSでは対象accountを照合した上でCost Explorerの30日・全service集計を取得し、次ページがないことを確認した。15日分にはestimatedフラグがあり、確定請求ではない。金額・service別明細は非公開の検証記録へ保管し、無関係なアカウント情報を本リポジトリへ公開しない。Budgets APIのCLI応答は空だったため、予算が存在しない/無制限であるとは判断しない。

残る受け入れ条件は、無料枠のリセット周期と残枠、通常/ピークの業務操作構成と成長、最終候補での操作別D1 rows/index検索回数、LLM・R2・AWS等を含む総費用、受け入れ済み月額上限の照合である。Neonからの固定費削減も今回の取得結果だけでは主張しない。
