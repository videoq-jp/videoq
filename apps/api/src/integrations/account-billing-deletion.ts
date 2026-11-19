import { features } from "../lib/deployment";
import Stripe from "stripe";
import { findBillingUser } from "../repositories/billing-repository";
import type { Bindings } from "../types/bindings";
import { requireStripeClient } from "../features/billing/stripe";

import { createAccountBillingDeletionService } from "../features/billing/account-deletion-service";

export function accountBillingDeletionService(env: Bindings) {
  return createAccountBillingDeletionService({
    enabled: features(env).billing,
    findUser: (target) => findBillingUser(env, target),
    async deleteCustomer(customerId) {
      try {
        await requireStripeClient(env).customers.del(customerId);
      } catch (error) {
        if (
          error instanceof Stripe.errors.StripeInvalidRequestError &&
          error.statusCode === 404 &&
          error.code === "resource_missing"
        )
          return;
        throw error;
      }
    },
  });
}
