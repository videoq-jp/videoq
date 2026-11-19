import type Stripe from 'stripe';
import { createBillingService } from '../features/billing/service';
import { createStripeGateway, billingEvent } from './stripe-gateway';
import { getBillingUser, findBillingUser, assignBillingCustomer, hasProcessedStripeEvent, commitStripeEvent } from '../repositories/billing-repository';
import type { Bindings } from '../types/bindings';

function billingService(env: Bindings) {
  return createBillingService({
    repository: {
      findUser: target => target.activeOnly && target.userId
        ? getBillingUser(env, target.userId) : findBillingUser(env, target),
      assignCustomer: (userId, customerId) => assignBillingCustomer(env, userId, customerId),
      hasEvent: id => hasProcessedStripeEvent(env, id),
      commitEvent: (event, update) => commitStripeEvent(env, event, update),
    },
    gateway: createStripeGateway(env),
  });
}

type Service = ReturnType<typeof createBillingService>;
export async function listPlans(env: Bindings, ...args: Parameters<Service["listPlans"]>) {
  return billingService(env).listPlans(...args);
}
export async function createCheckoutSession(env: Bindings, ...args: Parameters<Service["createCheckoutSession"]>) {
  return billingService(env).createCheckoutSession(...args);
}
export async function createPortalSession(env: Bindings, ...args: Parameters<Service["createPortalSession"]>) {
  return billingService(env).createPortalSession(...args);
}
export async function handleStripeEvent(env: Bindings, event: Stripe.Event): Promise<void> {
  return billingService(env).handleBillingEvent(billingEvent(event));
}
