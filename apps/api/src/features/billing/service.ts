import { usableBillingPriceAmount, billingCheckoutAlreadySubscribed, billingEventOwnerMatches, billingSubscriptionCustomerMatches, selectBillingSubscription, subscriptionEntitlementPatch } from '../../domain/billing/subscription-policy';
import {
  isPaidLookupKey, currencyForLocale,
  PAID_LOOKUP_KEYS, PLAN_CATALOG,
  type BillingCurrency, type PlanCode,
} from './catalog';
import { BillingStateChangedError, type BillingRepository, type BillingUpdate } from '../../persistence/contracts/billing-repository';
import type { BillingGateway, BillingPrice, BillingEvent, BillingEventTarget } from './ports';
import { validationFailure, conflict, notFound, unavailable } from '../../application/errors';

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

function priceAmount(price: BillingPrice, lookupKey: string, currency: BillingCurrency): number {
  const amount = usableBillingPriceAmount(price, lookupKey, currency);
  if (amount === null) {
    throw unavailable(
      `Stripe price '${lookupKey}' is not configured for ${currency.toUpperCase()}.`,
      "STRIPE_PRICE_UNAVAILABLE",
    );
  }
  return amount;
}


export interface BillingDependencies {
  repository: BillingRepository;
  gateway: BillingGateway;
}

/** Billing rules know neither Stripe SDK objects nor runtime bindings. */
export function createBillingService({ repository, gateway }: BillingDependencies) {
  async function listPlans(locale?: string): Promise<PublicPlan[]> {
    const currency = currencyForLocale(locale);
    const plans = catalogPlans(currency);
    if (!gateway.configured) return plans;
    const prices = await gateway.listPrices([...PAID_LOOKUP_KEYS]);
    const byLookup = new Map(prices.filter(p => p.lookupKey).map(p => [p.lookupKey, p]));
    return plans.map(plan => {
      if (!plan.lookup_key) return plan;
      const live = byLookup.get(plan.lookup_key);
      if (!live) throw unavailable(`Stripe price '${plan.lookup_key}' is not configured.`, 'STRIPE_PRICE_MISSING');
      return { ...plan, ...money(priceAmount(live, plan.lookup_key, currency), currency) };
    });
  }

  async function createCheckoutSession(userId: string, lookupKey: string, locale?: string): Promise<{ url: string }> {
    if (!isPaidLookupKey(lookupKey)) throw validationFailure('Unknown plan lookup key.', 'INVALID_LOOKUP_KEY');
    const user = await repository.findUser({ userId, activeOnly: true });
    if (!user) throw notFound('User not found');
    if (billingCheckoutAlreadySubscribed(user)) {
      throw conflict('You already have an active subscription. Manage it in the customer portal.', 'SUBSCRIPTION_EXISTS');
    }
    const currency = currencyForLocale(locale);
    const [price] = await gateway.listPrices([lookupKey], 1);
    if (!price) throw unavailable(`Stripe price '${lookupKey}' is not configured.`, 'STRIPE_PRICE_MISSING');
    priceAmount(price, lookupKey, currency);
    let customerId = user.stripeCustomerId;
    if (!customerId) {
      const created = await gateway.createCustomer(user.email, user.id);
      customerId = await repository.assignCustomer(user.id, created);
      if (!customerId) throw notFound('User not found');
    }
    const url = await gateway.createCheckout({ customerId, userId: user.id, priceId: price.id, lookupKey, currency, locale });
    if (!url) throw unavailable('Checkout session has no URL.', 'STRIPE_CHECKOUT_URL');
    return { url };
  }

  async function createPortalSession(userId: string, locale?: string): Promise<{ url: string }> {
    const user = await repository.findUser({ userId, activeOnly: true });
    if (!user) throw notFound('User not found');
    if (!user.stripeCustomerId) throw validationFailure('No billing customer on this account.', 'NO_STRIPE_CUSTOMER');
    return { url: await gateway.createPortal(user.stripeCustomerId, locale) };
  }

  async function prepareSubscriptionUpdate(target: BillingEventTarget): Promise<BillingUpdate | null> {
    const user = await repository.findUser(target);
    if (!user || !billingEventOwnerMatches(user.stripeCustomerId, target.customerId)) return null;
    let subscription = await gateway.retrieveSubscription(target.subscriptionId);
    if (!billingSubscriptionCustomerMatches(subscription, target.customerId)) return null;
    if (user.stripeSubscriptionId && user.stripeSubscriptionId !== subscription.id) {
      const current = await gateway.retrieveSubscription(user.stripeSubscriptionId);
      subscription = selectBillingSubscription(current, subscription);
    }
    return { userId: user.id, expectedRevision: user.revision, patch: subscriptionEntitlementPatch(subscription, target.customerId) };
  }

  async function handleBillingEvent(event: BillingEvent): Promise<void> {
    for (let attempt = 0; ; attempt += 1) {
      try {
        if (await repository.hasEvent(event.id)) return;
        const target = event.target;
        const update = target ? await prepareSubscriptionUpdate(target) : null;
        // Network lookups finish before the adapter opens the write transaction.
        await repository.commitEvent(event, update);
        return;
      } catch (error) {
        if (!(error instanceof BillingStateChangedError) || attempt >= 2) throw error;
      }
    }
  }

  return { listPlans, createCheckoutSession, createPortalSession, handleBillingEvent };
}
