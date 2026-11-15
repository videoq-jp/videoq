import { createBillingRepository } from "../persistence/factory";
import type { Bindings } from "../types/bindings";
import type { BillingTarget, BillingUpdate } from "../persistence/contracts/billing-repository";
export { BillingStateChangedError } from "../persistence/contracts/billing-repository";
export type { BillingUser, BillingPatch, BillingUpdate } from "../persistence/contracts/billing-repository";
export async function getBillingUser(env: Bindings,userId:string) {
  return findBillingUser(env,{userId,activeOnly:true});
}
export async function findBillingUser(env:Bindings,target:BillingTarget) {
  return (await createBillingRepository(env)).findUser(target);
}
export async function assignBillingCustomer(env:Bindings,userId:string,customerId:string) {
  return (await createBillingRepository(env)).assignCustomer(userId,customerId);
}
export async function hasProcessedStripeEvent(env:Bindings,eventId:string) {
  return (await createBillingRepository(env)).hasEvent(eventId);
}
export async function commitStripeEvent(env:Bindings,event:{id:string;type:string},update:BillingUpdate|null) {
  return (await createBillingRepository(env)).commitEvent(event,update);
}
