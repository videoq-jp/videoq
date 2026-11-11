# Stripe Dashboard 設定（VideoQ Billing）

有料プランの購入・変更と、利用上限の反映を確認する担当者向けの手順です。
通常の画面・API開発を始めるために、Stripeを設定する必要はありません。

StripeのProductは商品、Priceは金額と課金間隔、Webhookは決済状態の変更をAPIへ通知する仕組みです。
VideoQはPriceの `lookup_key` でプランを対応付けます。金額はDashboardが基準です。

まずテスト環境で設定し、末尾の動作確認を行います。APIキー・Price・Webhookの設定が同じ環境に属することを確認してください。

## 1. API キー

Restricted API key（`rk_`）を推奨する。Checkout / Customer / Subscriptions / Prices / Webhooks を許可する。

- Worker secret: `STRIPE_SECRET_KEY`
- Worker secret: `STRIPE_WEBHOOK_SECRET`
- ローカル: [`apps/api/.dev.vars.example`](https://github.com/videoq-jp/videoq/blob/main/apps/api/.dev.vars.example)

## 2. Product と Price

**別 Product にする。** Basic と Pro を同一 Product に載せない。

| Product | Price | lookup_key | 金額（JPY） | 間隔 |
|---|---|---|---|---|
| VideoQ Basic | 月額 | `basic_monthly` | 1480 | month |
| VideoQ Basic | 年額 | `basic_yearly` | 14800 | year |
| VideoQ Pro | 月額 | `pro_monthly` | 3980 | month |
| VideoQ Pro | 年額 | `pro_yearly` | 39800 | year |

### 英語サイトの米ドル料金

既存の4つのPrice IDと検索キーを維持し、各Priceの `currency_options.usd` に追加します。既存契約が参照する価格や検索キーは置き換えません。

| lookup_key | USD料金 | `unit_amount`（セント） |
|---|---:|---:|
| `basic_monthly` | 月$9.99 | 999 |
| `basic_yearly` | 年$99.90 | 9990 |
| `pro_monthly` | 月$26.99 | 2699 |
| `pro_yearly` | 年$269.90 | 26990 |

`currency_options.usd.tax_behavior` は既存の税込表示に合わせて `inclusive` とします。利用済み価格の通貨追加がDashboardで無効な場合、公式の[Price更新API](https://docs.stripe.com/api/prices/update)でUSDオプションのみ追加します。本番とサンドボックスは個別に設定します。

`billing.plans({ locale: "en" })` は `data.currency_options` を展開し、`unit_amount` にUSDのセント額を返します。日本語・言語省略時はJPYです。旧クライアントとの互換性のため、JPYレスポンスには `amount_yen` も残します。Stripeキーなしの開発環境では参照カタログを使用し、キーが設定済みなら価格・通貨・課金間隔が不正な場合はエラーにします。

Checkoutは英語で `currency=usd`、日本語で `currency=jpy` を明示し、決済画面の言語も合わせます。セッションのAdaptive Pricingを無効にして表示通貨と請求通貨を一致させます。既存契約の通貨は変更しません。Portalは表示言語と戻り先だけを変更します。Portalの変更可能な商品には、既存の4つの多通貨Priceを登録したままにします。

JPY はゼロ小数。`tax_behavior` は inclusive（内税）か、Tax settings の Automatic（JPY は inclusive）。

税コードは法務確認のうえ Product に付ける。候補:

- `txcd_10103001` SaaS — Business Use
- `txcd_10103000` SaaS — Personal Use

汎用 `txcd_10000000` は使わない。

## 3. Customer Portal

[Customer portal settings](https://dashboard.stripe.com/test/settings/billing/portal)

- 支払い方法の更新
- サブスクリプションの更新（Basic ⇔ Pro、月 ⇔ 年）
- Proration: `always_invoice`（公開ポリシーに合わせ、日割りを作って即時請求）
- 解約（期間末）

クラウド版の規約は、アップグレード・ダウングレードとも即時反映し、未使用分を
Stripe の請求クレジットで調整する内容です。低額プラン・短い請求周期への変更も
即時反映に設定してください。請求クレジットは現金返金とは異なります。
変更を確定する前に、適用日、請求周期、請求額・クレジットを確認します。
設定を変える場合は規約も確認してください。

2026年11月10日に本番のデフォルト設定で、期間末解約、日割り即時請求、
即時ダウングレード、Basic/Pro の月額・年額4価格の有効化を確認しました。
これは確認時点の記録であり、その後の管理画面の変更を自動監視するものではありません。

## 3.1 Public details（必須）

Checkout / Customer Portal に利用規約とプライバシーを出すには、Stripeで対象アカウントを選び、[Public details](https://dashboard.stripe.com/settings/public) に URL を入れる。アカウント固有のURLや連絡先は、チームのアクセス制限された運用記録で管理する。

| 項目 | URL |
|---|---|
| Terms of service | `https://videoq.jp/terms` |
| Privacy policy | `https://videoq.jp/privacy` |
| Support email | 対象環境で承認されたサポート窓口のアドレス |
| Support website | `https://videoq.jp` |

[Checkout settings](https://dashboard.stripe.com/settings/checkout) で Legal policies と Refund policy を有効にし、返金ポリシー全文は `https://videoq.jp/refund` を指す。日本の通信販売として [特商法表記](https://videoq.jp/legal) もサイトに置く。

Customer Portal の privacy / terms URL も同じ値にする。

APIはCheckoutごとに `consent_collection.terms_of_service=required` を指定します。テスト・本番両環境に有効な規約URLを登録してください。日英の確認文には4つの規約リンク、自動更新、利用枠、月次リセット、解約・返金条件を表示します。metadataの `legalPolicyVersion` だけでは同意を証明しないため、実際のSessionのconsentも確認してください。公開前に両言語・各請求周期の実画面を検証します。このチェックボックスは国外移転への同意ではありません。

## 4. Webhook

Endpoint: `https://videoq.jp/api/billing/webhook`

購読イベント:

- `checkout.session.completed`
- `customer.subscription.updated`
- `customer.subscription.deleted`
- `invoice.paid`
- `invoice.payment_failed`

ローカル: `stripe listen --forward-to localhost:8787/api/billing/webhook`

Webhook受信時はStripeから取得した最新の契約状態を反映します。遅れて届いた通知や契約に関係しない請求書で、新しい契約を上書きしません。イベントの処理記録とアカウントの更新は同じトランザクションで確定し、DB更新が競合した場合は契約を再取得します。解約後も契約IDとステータスは保持し、プラン由来の利用上限をFreeに戻します。再契約のためのCheckoutは引き続き利用できます。

管理画面からのアカウント削除では、アカウントを無効化した後、配送タスクが[Stripe顧客を削除](https://docs.stripe.com/api/customers/delete)してからデータ削除を開始します。顧客削除により有効な契約を解約し、開いたままのCheckoutからの再契約も防ぎます。Stripeで失敗した場合はユーザーと顧客IDを残して再試行するため、削除完了を判断する前に失敗・dead状態の外部タスクを確認してください。Stripe顧客を持たないアカウントの削除にはStripe設定は不要です。

## 5. 決済手段

Dashboard の dynamic payment methods を使う。コードに `payment_method_types` は渡さない。

## 6. Stripe Tax

`automatic_tax` は Worker の `STRIPE_AUTOMATIC_TAX=true` のときだけ有効。

有効化する前に:

1. Tax Settings で本店住所を入れる
2. 日本の消費税登録を **Collecting** にする
3. 登録なしでフラグを立てると、エラーなしで税額 0 のままになる

税務上の登録や税コードは、このシステム設定だけでは判断できません。契約主体の状況に合わせ、担当者が確認した設定を使用してください。

## 7. 動作確認

1. Free アカウントで `/pricing` から Basic 月額へ Checkout
2. Settings でプラン表示が Basic になる
3. Portal で年額または Pro に変更し、日割り請求を確認
4. 解約後に Free 枠へ戻る
5. Admin でクォータを手編集すると `quota_source=admin` になり、以降の webhook は枠を上書きしない。`quota_source=plan` に戻すとカタログを再適用する
6. DB移行後は、プラン管理の利用枠が現在のカタログと一致し、管理者の個別設定と利用済みカウンターが維持されていることを確認する。現在の文字起こし枠の移行は[運用手順](https://github.com/videoq-jp/videoq/blob/main/docs/operations/openai-transcription.md)を参照する。

## 8. 利用枠と費用試算

利用枠は `apps/api/src/features/billing/catalog.ts` の現在の `PLAN_CATALOG` を参照してください。
現在の文字起こしプロバイダーと利用枠の移行は
[運用手順](https://github.com/videoq-jp/videoq/blob/main/docs/operations/openai-transcription.md)にまとめています。
Modalを使っていた時期の予算表と旧カタログのスナップショットは削除しました。

リポジトリのルートで、現在のカタログから再計算できます。

```sh
python3 apps/worker/scripts/estimate_plan_costs.py --help
python3 apps/worker/scripts/estimate_plan_costs.py
```

計算スクリプトは契約数・利用量・インフラ・運営費の前提を出力し、引数で変更できます。
結果を使う前に前提を確認してください。過去の調査根拠は
`docs/verification/operating-cost-evidence-2026-10-02.json` に残していますが、現在の見積額ではありません。
