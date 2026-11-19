import type { Context } from "hono";
import * as billingService from "../../integrations/billing";
import type { AppEnv } from "../../types/bindings";
import { requireUserId, type HandlersFor } from "./shared";

export function billingHandlers(
  c: Context<AppEnv>,
  authenticatedUserId: string | null,
): HandlersFor<"billing"> {
  const userId = () => requireUserId(authenticatedUserId);
  return {
    "billing.plans": ({ locale }) => billingService.listPlans(c.env, locale),
    "billing.checkout": ({ lookupKey, locale }) =>
      billingService.createCheckoutSession(c.env, userId(), lookupKey, locale),
    "billing.portal": ({ locale }) =>
      billingService.createPortalSession(c.env, userId(), locale),
  };
}
