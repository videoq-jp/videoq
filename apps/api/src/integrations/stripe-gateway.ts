import type Stripe from 'stripe';
import type { BillingGateway, BillingEvent, BillingEventTarget, CheckoutRequest } from '../features/billing/ports';
import { checkoutDisclosure, LEGAL_POLICY_VERSION } from '../features/billing/checkout-disclosure';
import { automaticTaxEnabled, checkoutIntegrationIdentifier, frontendOrigin, localePrefix, requireStripeClient, stripeSecretKey } from '../features/billing/stripe';
import type { Bindings } from '../types/bindings';

export function createStripeGateway(env: Bindings): BillingGateway {
  // Lazily instantiate in the current request, only when provider I/O is needed.
  let client: Stripe | undefined;
  const stripe = () => client ??= requireStripeClient(env);
  return {
    configured: Boolean(stripeSecretKey(env)),
    listPrices: async (keys, limit) => (await stripe().prices.list({
      lookup_keys: [...keys], active: true, ...(limit ? { limit } : {}), expand: ['data.currency_options'],
    })).data.map(price => ({
      id: price.id, lookupKey: price.lookup_key, active: price.active,
      recurring: price.type === 'recurring', perUnit: price.billing_scheme === 'per_unit',
      interval: price.recurring?.interval ?? null, intervalCount: price.recurring?.interval_count ?? null,
      amounts: {
        jpy: price.currency === 'jpy' ? price.unit_amount : price.currency_options?.jpy?.unit_amount,
        usd: price.currency === 'usd' ? price.unit_amount : price.currency_options?.usd?.unit_amount,
      },
    })),
    createCustomer: async (email, userId) => (await stripe().customers.create({ email, metadata: { userId } })).id,
    createCheckout: input => createCheckout(stripe(), env, input),
    createPortal: async (customerId, locale) => (await stripe().billingPortal.sessions.create({
      customer: customerId, locale: locale === 'en' ? 'en' : 'ja',
      return_url: `${frontendOrigin(env)}${localePrefix(locale)}/settings`,
    })).url,
    retrieveSubscription: async id => {
      const subscription = await stripe().subscriptions.retrieve(id);
      return { id: subscription.id, customerId: objectId(subscription.customer), status: subscription.status,
        created: subscription.created, lookupKey: subscription.items.data[0]?.price?.lookup_key };
    },
  };
}

async function createCheckout(stripe: Stripe, env: Bindings, input: CheckoutRequest): Promise<string | null> {
  const { customerId, userId, priceId, lookupKey, currency, locale } = input;
  const origin = frontendOrigin(env);
  const prefix = localePrefix(locale);
  const tax = automaticTaxEnabled(env);
  const session = await stripe.checkout.sessions.create({
    mode: "subscription",
    currency,
    locale: locale === "en" ? "en" : "ja",
    adaptive_pricing: { enabled: false },
    customer: customerId,
    client_reference_id: userId,
    line_items: [{ price: priceId, quantity: 1 }],
    success_url: `${origin}${prefix}/settings?billing=success&session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${origin}${prefix}/pricing?billing=cancel`,
    billing_address_collection: "required",
    customer_update: { address: "auto", name: "auto" },
    tax_id_collection: { enabled: true },
    ...checkoutDisclosure(lookupKey, origin, locale),
    ...(tax ? { automatic_tax: { enabled: true } } : {}),
    metadata: { userId, lookupKey, legalPolicyVersion: LEGAL_POLICY_VERSION },
    subscription_data: {
      metadata: { userId, lookupKey, legalPolicyVersion: LEGAL_POLICY_VERSION },
    },
    integration_identifier: checkoutIntegrationIdentifier(),
  });
  return session.url;
}

function objectId(value: string | { id: string } | null | undefined): string | null {
  return typeof value === 'string' ? value : value?.id ?? null;
}

/** Convert only a signature-verified provider event into an application command. */
export function billingEvent(event: Stripe.Event): BillingEvent {
  // Dedupe needs only the envelope; do not inspect a redelivered payload.
  return { id: event.id, type: event.type, get target() { return eventTarget(event); } };
}

function eventTarget(event: Stripe.Event): BillingEventTarget | undefined {
  let customerId: string | null = null, subscriptionId: string | null = null, userId: string | null | undefined;
  switch (event.type) {
    case 'checkout.session.completed': {
      const session = event.data.object;
      customerId = objectId(session.customer);
      subscriptionId = objectId(session.subscription);
      userId = session.client_reference_id ?? session.metadata?.userId;
      break;
    }
    case 'customer.subscription.updated': case 'customer.subscription.deleted': {
      const subscription = event.data.object;
      customerId = objectId(subscription.customer);
      subscriptionId = subscription.id;
      userId = subscription.metadata?.userId;
      break;
    }
    case 'invoice.paid': case 'invoice.payment_failed': {
      const invoice = event.data.object;
      customerId = objectId(invoice.customer);
      subscriptionId = objectId(invoice.parent?.subscription_details?.subscription);
      userId = invoice.metadata?.userId;
      break;
    }
  }
  return subscriptionId ? { customerId, subscriptionId, userId } : undefined;
}
