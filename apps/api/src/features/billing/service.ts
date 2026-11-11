import type Stripe from "stripe";
import { checkoutDisclosure, LEGAL_POLICY_VERSION } from "./checkout-disclosure";
import {
  isPaidLookupKey,
  currencyForLocale,
  isPaidPlan,
  isUsableSubscriptionStatus,
  PAID_LOOKUP_KEYS,
  PLAN_CATALOG,
  planCodeFromLookupKey,
  type PaidLookupKey,
  type BillingCurrency,
  type PlanCode,
} from "./catalog";
import {
  assignBillingCustomer,
  getBillingUser,
  findBillingUser,
  hasProcessedStripeEvent,
  commitStripeEvent,
  BillingStateChangedError,
  type BillingPatch,
  type BillingUpdate,
} from "../../repositories/billing-repository";
import {
  apiBadRequest,
  apiConflict,
  apiNotFound,
  apiServiceUnavailable,
} from "../../shared/errors";
import type { Bindings } from "../../types/bindings";
import {
  automaticTaxEnabled,
  checkoutIntegrationIdentifier,
  frontendOrigin,
  localePrefix,
  requireStripeClient,
  stripeSecretKey,
} from "./stripe";

export type PublicPlan = {
  code: PlanCode;
  interval: "month" | "year" | null;
  lookup_key: string | null;
  unit_amount: number;
  amount_yen?: number;
  currency: BillingCurrency;
  entitlements: {
    max_video_upload_size_mb: number;
    storage_limit_gb: number;
    monthly_upload_limit_gb: number;
    processing_limit_minutes: number;
    ai_answers_limit: number;
  };
};

function entitlementsJson(planCode: PlanCode) {
  const e = PLAN_CATALOG[planCode].entitlements;
  return {
    max_video_upload_size_mb: e.maxVideoUploadSizeMb,
    storage_limit_gb: e.storageLimitGb,
    monthly_upload_limit_gb: e.monthlyUploadLimitGb,
    processing_limit_minutes: e.processingLimitMinutes,
    ai_answers_limit: e.aiAnswersLimit,
  };
}

function money(amount: number, currency: BillingCurrency) {
  return { unit_amount: amount, currency, ...(currency === "jpy" ? { amount_yen: amount } : {}) };
}

function catalogPlans(currency: BillingCurrency): PublicPlan[] {
  const plans: PublicPlan[] = [
    {
      code: "free",
      interval: null,
      lookup_key: null,
      ...money(0, currency),
      entitlements: entitlementsJson("free"),
    },
  ];
  for (const code of ["basic", "pro"] as const) {
    const def = PLAN_CATALOG[code];
    const amounts = currency === "usd" ? def.displayAmountUsdCents : def.displayAmountYen;
    plans.push(
      {
        code,
        interval: "month",
        lookup_key: def.lookupKeys.monthly ?? null,
        ...money(amounts.monthly, currency),
        entitlements: entitlementsJson(code),
      },
      {
        code,
        interval: "year",
        lookup_key: def.lookupKeys.yearly ?? null,
        ...money(amounts.yearly, currency),
        entitlements: entitlementsJson(code),
      },
    );
  }
  return plans;
}

function priceAmount(price: Stripe.Price, lookupKey: string, currency: BillingCurrency): number {
  const amount = price.currency === currency
    ? price.unit_amount
    : price.currency_options?.[currency]?.unit_amount;
  const interval = lookupKey.endsWith("_yearly") ? "year" : "month";
  if (!price.active || price.type !== "recurring" || price.recurring?.interval !== interval ||
      price.recurring.interval_count !== 1 || price.billing_scheme !== "per_unit" ||
      amount == null || !Number.isSafeInteger(amount) || amount <= 0) {
    throw apiServiceUnavailable(
      `Stripe price '${lookupKey}' is not configured for ${currency.toUpperCase()}.`,
      "STRIPE_PRICE_UNAVAILABLE",
    );
  }
  return amount;
}

export async function listPlans(env: Bindings, locale?: string): Promise<PublicPlan[]> {
  const currency = currencyForLocale(locale);
  const plans = catalogPlans(currency);
  const key = stripeSecretKey(env);
  if (!key) return plans;

  const stripe = requireStripeClient(env);
  const prices = await stripe.prices.list({
    lookup_keys: [...PAID_LOOKUP_KEYS],
    active: true,
    expand: ["data.currency_options"],
  });
  const byLookup = new Map<string, Stripe.Price>();
  for (const price of prices.data) {
    if (price.lookup_key) byLookup.set(price.lookup_key, price);
  }
  return plans.map((plan) => {
    if (!plan.lookup_key) return plan;
    const live = byLookup.get(plan.lookup_key);
    if (!live) {
      throw apiServiceUnavailable(`Stripe price '${plan.lookup_key}' is not configured.`, "STRIPE_PRICE_MISSING");
    }
    return { ...plan, ...money(priceAmount(live, plan.lookup_key, currency), currency) };
  });
}

async function priceIdForLookupKey(
  stripe: Stripe,
  lookupKey: PaidLookupKey,
  currency: BillingCurrency,
): Promise<string> {
  const prices = await stripe.prices.list({
    lookup_keys: [lookupKey],
    active: true,
    limit: 1,
    expand: ["data.currency_options"],
  });
  const price = prices.data[0];
  if (!price) {
    throw apiServiceUnavailable(
      `Stripe price '${lookupKey}' is not configured.`,
      "STRIPE_PRICE_MISSING",
    );
  }
  priceAmount(price, lookupKey, currency);
  return price.id;
}

export async function createCheckoutSession(
  env: Bindings,
  userId: string,
  lookupKey: string,
  locale?: string,
): Promise<{ url: string }> {
  if (!isPaidLookupKey(lookupKey)) {
    throw apiBadRequest("Unknown plan lookup key.", "INVALID_LOOKUP_KEY");
  }
  const user = await getBillingUser(env, userId);
  if (!user) throw apiNotFound("User not found");
  if (user.stripeSubscriptionId && isPaidPlan(user.planCode) && isUsableSubscriptionStatus(user.subscriptionStatus)) {
    throw apiConflict(
      "You already have an active subscription. Manage it in the customer portal.",
      "SUBSCRIPTION_EXISTS",
    );
  }

  const stripe = requireStripeClient(env);
  const currency = currencyForLocale(locale);
  const priceId = await priceIdForLookupKey(stripe, lookupKey, currency);
  let customerId = user.stripeCustomerId;
  if (!customerId) {
    const customer = await stripe.customers.create({
      email: user.email,
      metadata: { userId: user.id },
    });
    customerId = await assignBillingCustomer(env, user.id, customer.id);
    if (!customerId) throw apiNotFound("User not found");
  }

  const origin = frontendOrigin(env);
  const prefix = localePrefix(locale);
  const tax = automaticTaxEnabled(env);
  const session = await stripe.checkout.sessions.create({
    mode: "subscription",
    currency,
    locale: locale === "en" ? "en" : "ja",
    adaptive_pricing: { enabled: false },
    customer: customerId,
    client_reference_id: user.id,
    line_items: [{ price: priceId, quantity: 1 }],
    success_url: `${origin}${prefix}/settings?billing=success&session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${origin}${prefix}/pricing?billing=cancel`,
    billing_address_collection: "required",
    customer_update: { address: "auto", name: "auto" },
    tax_id_collection: { enabled: true },
    ...checkoutDisclosure(lookupKey, origin, locale),
    ...(tax ? { automatic_tax: { enabled: true } } : {}),
    metadata: { userId: user.id, lookupKey, legalPolicyVersion: LEGAL_POLICY_VERSION },
    subscription_data: {
      metadata: { userId: user.id, lookupKey, legalPolicyVersion: LEGAL_POLICY_VERSION },
    },
    integration_identifier: checkoutIntegrationIdentifier(),
  });
  if (!session.url) {
    throw apiServiceUnavailable("Checkout session has no URL.", "STRIPE_CHECKOUT_URL");
  }
  return { url: session.url };
}

export async function createPortalSession(
  env: Bindings,
  userId: string,
  locale?: string,
): Promise<{ url: string }> {
  const user = await getBillingUser(env, userId);
  if (!user) throw apiNotFound("User not found");
  if (!user.stripeCustomerId) {
    throw apiBadRequest("No billing customer on this account.", "NO_STRIPE_CUSTOMER");
  }
  const stripe = requireStripeClient(env);
  const origin = frontendOrigin(env);
  const prefix = localePrefix(locale);
  const session = await stripe.billingPortal.sessions.create({
    customer: user.stripeCustomerId,
    locale: locale === "en" ? "en" : "ja",
    return_url: `${origin}${prefix}/settings`,
  });
  return { url: session.url };
}

function customerIdFrom(value: string | Stripe.Customer | Stripe.DeletedCustomer | null): string | null {
  if (!value) return null;
  if (typeof value === "string") return value;
  return value.id;
}

function subscriptionIdFrom(
  value: string | Stripe.Subscription | null | undefined,
): string | null {
  if (!value) return null;
  return typeof value === "string" ? value : value.id;
}

function subscriptionPatch(
  subscription: Stripe.Subscription,
  customerId: string | null,
): BillingPatch {
  const status = subscription.status;
  const lookupKey = subscription.items.data[0]?.price?.lookup_key;
  const planCode = lookupKey ? planCodeFromLookupKey(lookupKey) ?? "free" : "free";
  const effectivePlan = isUsableSubscriptionStatus(status) ? planCode : "free";
  return {
    stripeCustomerId: customerId ?? undefined,
    stripeSubscriptionId: subscription.id,
    planCode: effectivePlan,
    subscriptionStatus: status,
    entitlements: PLAN_CATALOG[effectivePlan].entitlements,
  };
}

/** Events are hints: their snapshots can arrive late or in reverse order. */
async function prepareSubscriptionUpdate(
  env: Bindings,
  target: { userId?: string | null; customerId: string | null; subscriptionId: string },
): Promise<BillingUpdate | null> {
  const user = await findBillingUser(env, target);
  if (!user || (user.stripeCustomerId && target.customerId !== user.stripeCustomerId)) return null;

  const stripe = requireStripeClient(env);
  let subscription = await stripe.subscriptions.retrieve(target.subscriptionId);
  if (customerIdFrom(subscription.customer) !== target.customerId) return null;
  if (user.stripeSubscriptionId && user.stripeSubscriptionId !== subscription.id) {
    // A delayed cancellation/invoice for an older subscription must not replace
    // a newer one. Keep a current usable contract, or the more recent contract
    // when both have ended. Stripe creation time belongs to the contracts, not
    // webhook event ordering.
    const current = await stripe.subscriptions.retrieve(user.stripeSubscriptionId);
    if (isUsableSubscriptionStatus(current.status) || current.created > subscription.created ||
      (current.created === subscription.created && !isUsableSubscriptionStatus(subscription.status))) {
      subscription = current;
    }
  }
  // Retain the contract ID even after cancellation so delayed notifications for
  // an older contract cannot replace it. Checkout still allows a new contract.
  return {
    userId: user.id,
    expectedRevision: user.revision,
    patch: subscriptionPatch(subscription, target.customerId),
  };
}

async function prepareCheckoutCompleted(
  env: Bindings,
  session: Stripe.Checkout.Session,
): Promise<BillingUpdate | null> {
  const customerId = customerIdFrom(session.customer);
  const subId = subscriptionIdFrom(session.subscription);
  // Payment/setup sessions and standalone invoices do not describe a subscription.
  if (!subId) return null;
  return prepareSubscriptionUpdate(env, {
    userId: session.client_reference_id ?? session.metadata?.userId,
    customerId,
    subscriptionId: subId,
  });
}

async function prepareSubscriptionChange(
  env: Bindings,
  subscription: Stripe.Subscription,
): Promise<BillingUpdate | null> {
  const customerId = customerIdFrom(subscription.customer);
  return prepareSubscriptionUpdate(env, {
    userId: subscription.metadata?.userId, customerId, subscriptionId: subscription.id,
  });
}

async function prepareInvoiceEvent(
  env: Bindings,
  invoice: Stripe.Invoice,
): Promise<BillingUpdate | null> {
  const customerId = customerIdFrom(invoice.customer);
  const subId = subscriptionIdFrom(invoice.parent?.subscription_details?.subscription);
  if (!subId) return null;
  return prepareSubscriptionUpdate(env, {
    userId: invoice.metadata?.userId, customerId, subscriptionId: subId,
  });
}

export async function handleStripeEvent(env: Bindings, event: Stripe.Event): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      await reconcileStripeEvent(env, event);
      return;
    } catch (error) {
      if (!(error instanceof BillingStateChangedError) || attempt >= 2) throw error;
    }
  }
}

async function reconcileStripeEvent(env: Bindings, event: Stripe.Event): Promise<void> {
  // This read avoids Stripe I/O on redelivery. The transaction below is the authoritative dedupe.
  if (await hasProcessedStripeEvent(env, event.id)) return;
  let update: BillingUpdate | null = null;
  switch (event.type) {
    case "checkout.session.completed":
      update = await prepareCheckoutCompleted(env, event.data.object);
      break;
    case "customer.subscription.updated":
    case "customer.subscription.deleted":
      update = await prepareSubscriptionChange(env, event.data.object);
      break;
    case "invoice.paid":
    case "invoice.payment_failed":
      update = await prepareInvoiceEvent(env, event.data.object);
      break;
  }
  // All network lookups finish before opening the write transaction.
  await commitStripeEvent(env, event, update);
}
