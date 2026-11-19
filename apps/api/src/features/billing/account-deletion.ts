import type { Bindings } from "../../types/bindings";
import { accountBillingDeletionService } from "../../integrations/account-billing-deletion";

/** Durable outbox entrypoint; failures must retain the billing identity for retry. */
export function deleteAccountBilling(
  env: Bindings,
  userId: string,
): Promise<void> {
  return accountBillingDeletionService(env)(userId);
}
