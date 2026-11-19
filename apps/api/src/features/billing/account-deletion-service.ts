import type { BillingRepository } from "../../persistence/contracts/billing-repository";

export interface AccountBillingDeletionDependencies {
  enabled: boolean;
  findUser: BillingRepository["findUser"];
  /** Idempotent provider deletion. Missing customers count as already deleted. */
  deleteCustomer(customerId: string): Promise<void>;
}

/** The outbox must await this before deleting the account's billing identity. */
export function createAccountBillingDeletionService(
  deps: AccountBillingDeletionDependencies,
) {
  return async (userId: string): Promise<void> => {
    if (!deps.enabled) return;
    // Include banned users, retaining the customer link across retries.
    const user = await deps.findUser({ userId });
    if (user?.stripeCustomerId)
      await deps.deleteCustomer(user.stripeCustomerId);
  };
}
