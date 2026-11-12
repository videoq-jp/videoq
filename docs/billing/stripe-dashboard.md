# Stripe Dashboard setup (VideoQ Billing)

This guide is for those verifying paid-plan purchases, changes, and usage limits.
Stripe setup is not required to begin ordinary frontend or API development.

A Stripe Product represents a product, a Price defines its amount and billing interval,
and a webhook notifies the API of payment state changes. VideoQ maps plans through
Price `lookup_key` values. The Dashboard is the source of truth for amounts.

Configure the test environment first, then follow the verification steps below.
Ensure API keys, Prices, and webhooks all belong to the same environment.

## 1. API keys

Use a restricted API key (`rk_`) where possible. Allow Checkout / Customer / Subscriptions / Prices / Webhooks.

- Worker secret: `STRIPE_SECRET_KEY`
- Worker secret: `STRIPE_WEBHOOK_SECRET`
- Local configuration: [`apps/api/.dev.vars.example`](https://github.com/videoq-jp/videoq/blob/main/apps/api/.dev.vars.example)

## 2. Products and Prices

**Use separate Products.** Do not put Basic and Pro under the same Product.

| Product | Price | lookup_key | Amount (JPY) | Interval |
|---|---|---|---|---|
| VideoQ Basic | Monthly | `basic_monthly` | 1480 | month |
| VideoQ Basic | Yearly | `basic_yearly` | 14800 | year |
| VideoQ Pro | Monthly | `pro_monthly` | 3980 | month |
| VideoQ Pro | Yearly | `pro_yearly` | 39800 | year |

### English-site USD prices

Keep the four existing Price IDs and lookup keys. Add USD using each Price's `currency_options.usd` (do not replace prices or move lookup keys used by existing subscriptions):

| Lookup key | USD price | `unit_amount` (cents) |
|---|---:|---:|
| `basic_monthly` | $9.99/month | 999 |
| `basic_yearly` | $99.90/year | 9990 |
| `pro_monthly` | $26.99/month | 2699 |
| `pro_yearly` | $269.90/year | 26990 |

Set `currency_options.usd.tax_behavior` to `inclusive`, matching the existing tax-inclusive pricing policy. If Dashboard disables adding currency options to a used price, use the official [Update Price API](https://docs.stripe.com/api/prices/update) to add the USD option without modifying JPY. Configure both sandbox and live environments separately.

`billing.plans({ locale: "en" })` expands `data.currency_options` and returns USD cents in `unit_amount`; Japanese or omitted locale returns JPY. `amount_yen` remains on JPY responses for old clients. Without a Stripe key, development uses the reference catalog. With a key configured, missing prices/currencies or invalid recurring intervals fail rather than displaying a price Checkout cannot charge.

Checkout explicitly sets `currency=usd` for English and `currency=jpy` otherwise, plus the matching UI locale. Adaptive Pricing is disabled for the session to keep the displayed currency and charge consistent. Existing subscriptions retain their currency. Portal sessions only change language and return URL; they do not convert a subscription. Keep the original four multi-currency Prices in the portal's allowed products.

JPY is a zero-decimal currency. Set `tax_behavior` to inclusive, or use Automatic in Tax settings (inclusive for JPY).

Assign a tax code to each Product after legal review. Candidates:

- `txcd_10103001` SaaS — Business Use
- `txcd_10103000` SaaS — Personal Use

Do not use the generic `txcd_10000000`.

## 3. Customer Portal

[Customer portal settings](https://dashboard.stripe.com/test/settings/billing/portal)

- Payment method updates
- Subscription updates (Basic ⇔ Pro, monthly ⇔ yearly)
- Proration: `always_invoice` (create prorations and invoice immediately, matching the published policies)
- Cancellation at the end of the period

The hosted policies describe immediate upgrades **and downgrades**, with unused
time credited through Stripe billing adjustments. Keep both cheaper-plan and
shorter-interval downgrades set to update immediately. A billing credit is not a
cash refund. Review the effective date, billing-cycle change and invoice/credit
preview before confirming a change. Changing these settings requires a policy review.

The production default configuration was inspected on 2026-11-10: period-end
cancellation, immediate prorated invoices, immediate downgrades and all four
Basic/Pro monthly/yearly prices were enabled. This is dated evidence, not an
automated guarantee against later Dashboard changes.

## 3.1 Public details (required)

To show terms and privacy policies in Checkout / Customer Portal, select the appropriate account in Stripe and enter URLs in [Public details](https://dashboard.stripe.com/settings/public). Keep account-specific URLs and contact details in the team's access-controlled operations records.

| Field | URL |
|---|---|
| Terms of service | `https://videoq.jp/terms` |
| Privacy policy | `https://videoq.jp/privacy` |
| Support email | The approved support address for the selected environment |
| Support website | `https://videoq.jp` |

Enable Legal policies and Refund policy in [Checkout settings](https://dashboard.stripe.com/settings/checkout), linking the full refund policy to `https://videoq.jp/refund`. Also publish the [disclosure under Japan's Specified Commercial Transactions Act](https://videoq.jp/legal) for Japanese mail-order sales.

Use the same privacy and terms URLs in Customer Portal.

The API requires explicit Terms acceptance per Checkout session using `consent_collection.terms_of_service=required`. Configure a valid public Terms URL in both test and live accounts. Localized confirmation text links all four policies and describes renewal, quotas, monthly resets, cancellation and refunds. Checkout and Subscription metadata record `legalPolicyVersion`; verify actual Session consent separately. Check the hosted screen in both languages and billing intervals before release. This checkbox is not foreign-transfer consent.

## 4. Webhook

Endpoint: `https://videoq.jp/api/billing/webhook`

Subscribe to:

- `checkout.session.completed`
- `customer.subscription.updated`
- `customer.subscription.deleted`
- `invoice.paid`
- `invoice.payment_failed`

Local forwarding: `stripe listen --forward-to localhost:8787/api/billing/webhook`

Webhooks reconcile the latest subscription retrieved from Stripe. Delayed events
and standalone invoices must not overwrite a newer subscription. The API commits
each event receipt together with its account update; database conflicts retry the
lookup before committing. Canceled subscription IDs and statuses remain recorded,
while plan-based quotas return to Free. A new checkout is still allowed.

Admin account deletion first disables the account, then the durable delivery task
[deletes its Stripe customer](https://docs.stripe.com/api/customers/delete) before
dispatching data deletion. Customer deletion cancels active subscriptions and
prevents new subscriptions through an already-open checkout. Stripe failures keep
the user record and customer ID available for retry; inspect failed/dead external
tasks before treating account deletion as complete. Accounts without a Stripe
customer do not require Stripe configuration for deletion.

## 5. Payment methods

Use the Dashboard's dynamic payment methods. Do not pass `payment_method_types` in code.

## 6. Stripe Tax

`automatic_tax` is enabled only when the Worker's `STRIPE_AUTOMATIC_TAX=true`.

Before enabling it:

1. Enter the business address in Tax Settings.
2. Set the Japanese consumption tax registration to **Collecting**.
3. Enabling the flag without a registration can leave tax at 0 without an error.

Tax registration and tax-code choices cannot be determined from this system configuration alone. Use settings verified by the responsible person for the contracting entity's circumstances.

## 7. Verify behavior

1. From a Free account, check out for Basic monthly via `/pricing`.
2. Confirm that Settings shows the Basic plan.
3. Switch to yearly billing or Pro in the Portal and verify proration.
4. Confirm that quotas return to Free after cancellation takes effect.
5. Manually editing quotas in Admin sets `quota_source=admin`; subsequent webhooks do not overwrite those limits. Setting it back to `quota_source=plan` reapplies the catalog.
6. After database migrations, verify that plan-managed allowances match the current catalog and administrator overrides and used counters remain intact. The current transcription migration is described in the [operations guide](https://github.com/videoq-jp/videoq/blob/main/docs/operations/openai-transcription.md).

## 8. Usage allowances and cost planning

Use the current `PLAN_CATALOG` in `apps/api/src/features/billing/catalog.ts` for
allowances. [Cloud transcription operations](https://github.com/videoq-jp/videoq/blob/main/docs/operations/openai-transcription.md)
describes the active provider and allowance migration. Historical Modal-era
budgets and catalog snapshots have been retired.

Recalculate against the current catalog from the repository root:

```sh
python3 apps/worker/scripts/estimate_plan_costs.py --help
python3 apps/worker/scripts/estimate_plan_costs.py
```

The calculator exposes its assumptions and accepts overrides for contracts,
usage, infrastructure and operating expense. Review those assumptions before
using its output. Sanitized historical input evidence remains in
`docs/verification/operating-cost-evidence-2026-10-02.json`; it is not a live quote.
