import type Stripe from "stripe";
import { PLAN_CATALOG, planCodeFromLookupKey, type PaidLookupKey } from "./catalog";

// Update alongside the dated legal pages when the purchase terms change.
export const LEGAL_POLICY_VERSION = "2026-11-11";

/** Keep the last confirmation screen consistent with the actual plan allowances. */
export function checkoutDisclosure(
  lookupKey: PaidLookupKey,
  origin: string,
  locale?: string,
): Pick<Stripe.Checkout.SessionCreateParams, "consent_collection" | "custom_text"> {
  const code = planCodeFromLookupKey(lookupKey);
  if (!code) throw new Error("Unknown paid plan");
  const quota = PLAN_CATALOG[code].entitlements;
  const english = locale === "en";
  const prefix = english ? "/en" : "";
  const yearly = lookupKey.endsWith("_yearly");
  const terms = `${origin}${prefix}/terms`;
  const privacy = `${origin}${prefix}/privacy`;
  const refund = `${origin}${prefix}/refund`;
  const legal = `${origin}${prefix}/legal`;

  return {
    consent_collection: { terms_of_service: "required" },
    custom_text: {
      submit: {
        message: english
          ? `Renews ${yearly ? "yearly" : "monthly"} until canceled. Storage: ${quota.storageLimitGb} GB. Monthly allowances: ${quota.processingLimitMinutes} transcription minutes, ${quota.aiAnswersLimit} AI answers, ${quota.monthlyUploadLimitGb} GB uploads. Monthly usage resets on the first day of each month (UTC), including annual plans. Cancel in Settings before renewal; access continues to period end. Unused time is not refunded except under the [refund policy](${refund}). Support: support@videoq.jp.`
          : `解約まで${yearly ? "毎年" : "毎月"}自動更新します。ストレージ${quota.storageLimitGb}GB、月間利用枠は文字起こし${quota.processingLimitMinutes}分・AI回答${quota.aiAnswersLimit}回・アップロード${quota.monthlyUploadLimitGb}GBです。年額契約でも月間利用量は毎月1日（UTC）にリセットします。次回更新前に設定から解約すると、期間末まで利用できます。未使用分は[返金ポリシー](${refund})に定める場合を除き返金しません。問い合わせ: support@videoq.jp。`,
      },
      terms_of_service_acceptance: {
        message: english
          ? `I agree to the [Terms of Service](${terms}) and have read the [Privacy Policy](${privacy}), [Refund and Cancellation Policy](${refund}) and [Legal notice](${legal}).`
          : `[利用規約](${terms})に同意し、[プライバシーポリシー](${privacy})・[返金・解約ポリシー](${refund})・[特商法表記](${legal})を確認しました。`,
      },
    },
  };
}
