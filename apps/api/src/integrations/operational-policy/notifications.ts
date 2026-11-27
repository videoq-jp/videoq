import type { PolicyEvent } from '../../domain/operations/operational-policy';
export type PolicyNotificationSink = {url:string;token:string};
/** Sink must implement Idempotency-Key semantics. Unknown delivery outcomes may retry. */
export async function deliverPolicyNotification(sink:PolicyNotificationSink,event:PolicyEvent,idempotencyKey:string,send:typeof fetch=fetch) {
  const url=new URL(sink.url);
  if(url.protocol!=='https:'||url.username||url.password||url.hash||!sink.token) throw Error('Invalid policy notification configuration');
  try {
    const response=await send(url,{method:'POST',redirect:'manual',signal:AbortSignal.timeout(10000),headers:{'content-type':'application/json',authorization:`Bearer ${sink.token}`,'Idempotency-Key':idempotencyKey},
      body:JSON.stringify({event:event.kind,subject:idempotencyKey,severity:event.severity,ageMs:event.ageMs,owner:event.owner,policyDate:event.policyDate})});
    await response.body?.cancel();
    if(!response.ok) throw Error('Delivery rejected');
  } catch { throw Error('Policy notification delivery failed'); }
}
