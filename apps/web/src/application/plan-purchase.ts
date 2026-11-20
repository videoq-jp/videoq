/** Existing subscribers manage changes through the billing portal. */
export function planPurchaseAction(currentPlan: string | undefined, selectedPlan: string): 'current' | 'portal' | 'checkout' {
  if (selectedPlan === 'free' && selectedPlan === currentPlan) return 'current';
  return currentPlan !== 'free' ? 'portal' : 'checkout';
}
