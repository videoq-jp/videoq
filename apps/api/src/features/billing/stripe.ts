import { requireFeature } from "../../lib/deployment";
import Stripe from "stripe";
import type { Bindings } from "../../types/bindings";
import { apiServiceUnavailable } from "../../shared/errors";
import { stripTrailingSlashes } from "../../lib/url";

const STRIPE_API_VERSION = "2026-10-28.endive" as const;

export function stripeSecretKey(env: Bindings): string | null {
  const key = env.STRIPE_SECRET_KEY?.trim();
  return key ? key : null;
}

function createStripeClient(apiKey: string): Stripe {
  return new Stripe(apiKey, {
    apiVersion: STRIPE_API_VERSION,
    httpClient: Stripe.createFetchHttpClient(),
    typescript: true,
  });
}

export function requireStripeClient(env: Bindings): Stripe {
  requireFeature(env, "billing");
  const key = stripeSecretKey(env);
  if (!key) {
    throw apiServiceUnavailable("Stripe is not configured.", "STRIPE_NOT_CONFIGURED");
  }
  return createStripeClient(key);
}

export function automaticTaxEnabled(env: Bindings): boolean {
  return env.STRIPE_AUTOMATIC_TAX?.trim().toLowerCase() === "true";
}

export function frontendOrigin(env: Bindings): string {
  return stripTrailingSlashes(env.FRONTEND_URL ?? "http://localhost");
}

export function localePrefix(locale: string | undefined): string {
  return locale === "en" ? "/en" : "";
}

export function checkoutIntegrationIdentifier(): string {
  let suffix = "";
  const bytes = new Uint8Array(16);
  while (suffix.length < 8) {
    crypto.getRandomValues(bytes);
    for (const byte of bytes) {
      // Five unbiased bits cover 0..31; reject the values outside a..z.
      const letter = byte & 31;
      if (letter >= 26) continue;
      suffix += String.fromCharCode(97 + letter);
      if (suffix.length === 8) break;
    }
  }
  return `videoq-checkout-${suffix}`;
}
