import { requireFeature } from "../../lib/deployment";
import { Hono } from "hono";
import { apiBadRequest, apiServiceUnavailable } from "../../shared/errors";
import type { AppEnv } from "../../types/bindings";
import { onError } from "../../middleware/error-handler";
import * as billingService from "../../integrations/billing";
import { requireStripeClient } from "./stripe";

/** Stripe requires the untouched request body for signature verification. */
export const billingRoutes = new Hono<AppEnv>();
billingRoutes.onError(onError);

billingRoutes.post("/webhook", async (c) => {
  requireFeature(c.env, "billing");
  const secret = c.env.STRIPE_WEBHOOK_SECRET?.trim();
  if (!secret) {
    throw apiServiceUnavailable("Webhook secret is not configured.", "STRIPE_WEBHOOK_UNSET");
  }
  const signature = c.req.header("stripe-signature");
  if (!signature) throw apiBadRequest("Missing Stripe-Signature header.", "MISSING_SIGNATURE");

  const rawBody = await c.req.text();
  const stripe = requireStripeClient(c.env);
  let event;
  try {
    event = await stripe.webhooks.constructEventAsync(rawBody, signature, secret);
  } catch {
    throw apiBadRequest("Invalid Stripe webhook signature.", "INVALID_SIGNATURE");
  }

  await billingService.handleStripeEvent(c.env, event);
  return c.json({ received: true }, 200);
});
