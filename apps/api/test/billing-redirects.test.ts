import { beforeEach, describe, expect, it, vi } from "vitest";
import { createCheckoutSession, createPortalSession } from "../src/features/billing/service";
import { getBillingUser } from "../src/repositories/billing-repository";
import type { Bindings } from "../src/types/bindings";

const { checkoutCreate, portalCreate, pricesList } = vi.hoisted(() => ({
  checkoutCreate: vi.fn(),
  portalCreate: vi.fn(),
  pricesList: vi.fn(),
}));

vi.mock("../src/repositories/billing-repository");
vi.mock("stripe", () => ({
  default: class {
    static createFetchHttpClient() { return {}; }
    prices = { list: pricesList };
    checkout = { sessions: { create: checkoutCreate } };
    billingPortal = { sessions: { create: portalCreate } };
  },
}));

const env = {
  FRONTEND_URL: "https://videoq.example/",
  STRIPE_SECRET_KEY: "sk_test_billing",
} as Bindings;

beforeEach(() => {
  pricesList.mockReset().mockResolvedValue({ data: [{
    id: "price_basic", lookup_key: "basic_monthly", active: true, type: "recurring",
    billing_scheme: "per_unit", recurring: { interval: "month", interval_count: 1 },
    currency: "jpy", unit_amount: 1480, currency_options: { usd: { unit_amount: 999 } },
  }] });
  checkoutCreate.mockReset().mockResolvedValue({ url: "https://checkout.stripe.com/test" });
  portalCreate.mockReset().mockResolvedValue({ url: "https://billing.stripe.com/test" });
  vi.mocked(getBillingUser).mockResolvedValue({
    id: "user_1",
    email: "user@example.test",
    stripeCustomerId: "cus_1",
    stripeSubscriptionId: null,
    planCode: "free",
    subscriptionStatus: null,
  });
});

describe.each([
  { locale: "ja", prefix: "" },
  { locale: "en", prefix: "/en" },
  { locale: undefined, prefix: "" },
])("billing redirects for locale $locale", ({ locale, prefix }) => {
  it("returns checkout success and cancellation to the same language", async () => {
    await createCheckoutSession(env, "user_1", "basic_monthly", locale);

    expect(checkoutCreate).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      success_url: `https://videoq.example${prefix}/settings?billing=success&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `https://videoq.example${prefix}/pricing?billing=cancel`,
      currency: locale === "en" ? "usd" : "jpy",
      locale: locale === "en" ? "en" : "ja",
      adaptive_pricing: { enabled: false },
      line_items: [{ price: "price_basic", quantity: 1 }],
      consent_collection: { terms_of_service: "required" },
      metadata: { userId: "user_1", lookupKey: "basic_monthly", legalPolicyVersion: "2026-11-11" },
      subscription_data: {
        metadata: { userId: "user_1", lookupKey: "basic_monthly", legalPolicyVersion: "2026-11-11" },
      },
    }));
    const params = checkoutCreate.mock.calls[0][0];
    const acceptance = params.custom_text.terms_of_service_acceptance.message;
    for (const path of ["terms", "privacy", "refund", "legal"]) {
      expect(acceptance).toContain(`https://videoq.example${prefix}/${path}`);
    }
    expect(params.custom_text.submit.message).toContain("support@videoq.jp");
  });

  it("returns the billing portal to settings in the same language", async () => {
    await createPortalSession(env, "user_1", locale);

    expect(portalCreate).toHaveBeenCalledExactlyOnceWith({
      customer: "cus_1",
      locale: locale === "en" ? "en" : "ja",
      return_url: `https://videoq.example${prefix}/settings`,
    });
  });
});

describe.each([
  { lookup: "basic_monthly", interval: "month", storage: 20, minutes: 200, answers: 500, uploads: 200 },
  { lookup: "basic_yearly", interval: "year", storage: 20, minutes: 200, answers: 500, uploads: 200 },
  { lookup: "pro_monthly", interval: "month", storage: 100, minutes: 1000, answers: 2000, uploads: 1000 },
  { lookup: "pro_yearly", interval: "year", storage: 100, minutes: 1000, answers: 2000, uploads: 1000 },
])("checkout contract for $lookup", ({ lookup, interval, storage, minutes, answers, uploads }) => {
  it.each(["ja", "en"])("shows the selected plan's allowances and renewal interval in %s", async locale => {
    pricesList.mockResolvedValue({ data: [{
      id: "price_selected", lookup_key: lookup, active: true, type: "recurring",
      billing_scheme: "per_unit", recurring: { interval, interval_count: 1 },
      currency: "jpy", unit_amount: 1480, currency_options: { usd: { unit_amount: 999 } },
    }] });
    await createCheckoutSession(env, "user_1", lookup, locale);
    const params = checkoutCreate.mock.calls[0][0];
    const summary = params.custom_text.submit.message;
    if (locale === "en") {
      expect(summary).toContain(interval === "year" ? "Renews yearly" : "Renews monthly");
      expect(summary).toContain(`Storage: ${storage} GB`);
      expect(summary).toContain(`${minutes} transcription minutes, ${answers} AI answers, ${uploads} GB uploads`);
    } else {
      expect(summary).toContain(interval === "year" ? "毎年自動更新" : "毎月自動更新");
      expect(summary).toContain(`ストレージ${storage}GB`);
      expect(summary).toContain(`文字起こし${minutes}分・AI回答${answers}回・アップロード${uploads}GB`);
    }
    expect(summary).toContain("UTC");
    expect(summary.length).toBeLessThanOrEqual(1200);
    expect(params.custom_text.terms_of_service_acceptance.message.length).toBeLessThanOrEqual(1200);
  });
});

it("refuses English checkout when USD is missing instead of charging JPY", async () => {
  pricesList.mockResolvedValue({ data: [{
    id: "price_basic", active: true, type: "recurring", billing_scheme: "per_unit",
    recurring: { interval: "month", interval_count: 1 }, currency: "jpy", unit_amount: 1480,
  }] });
  await expect(createCheckoutSession(env, "user_1", "basic_monthly", "en")).rejects.toThrow("USD");
  expect(checkoutCreate).not.toHaveBeenCalled();
});

it("does not create a second subscription when an existing JPY subscriber opens the English site", async () => {
  vi.mocked(getBillingUser).mockResolvedValue({
    id: "user_1", email: "user@example.test", stripeCustomerId: "cus_1",
    stripeSubscriptionId: "sub_jpy", planCode: "basic", subscriptionStatus: "active",
  });
  await expect(createCheckoutSession(env, "user_1", "pro_monthly", "en")).rejects.toThrow("already have an active subscription");
  expect(checkoutCreate).not.toHaveBeenCalled();
});
