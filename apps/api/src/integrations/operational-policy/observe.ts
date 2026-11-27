import {embeddingFingerprint,embeddingDimensions,resolveEmbeddingConfig} from '../../lib/embedding-contract';
import { createD1OperationalPolicyRepository } from '../../persistence/d1/operational-policy';
import { evaluateOperationalPolicy } from '../../domain/operations/operational-policy';
import { deliverPolicyNotification } from './notifications';
import { persistenceBackend } from '../../persistence/backend';
import type { Bindings } from '../../types/bindings';
export async function observeOperationalPolicy(env:Bindings,now:Date,send:typeof fetch=fetch) {
  if(persistenceBackend(env)!=='d1') return {status:'unsupported_onprem_source_facts',delivered:0};
  if(!env.DB) throw Error('Policy observation requires D1');
  if(!env.OPERATIONAL_POLICY_WEBHOOK_URL||!env.OPERATIONAL_POLICY_WEBHOOK_TOKEN) return {status:'notification_sink_unconfigured',delivered:0};
  const config=resolveEmbeddingConfig(env);
  const repository=createD1OperationalPolicyRepository(env.DB,{fingerprint:await embeddingFingerprint(config),dimensions:embeddingDimensions(config)});
  const snapshot=await repository.read(now.toISOString());
  const {events}=evaluateOperationalPolicy(snapshot);
  let delivered=0,failed=0;
  for(const event of events) {
    const id=event.kind.startsWith('search_')?'readiness:'+event.id:'cleanup:'+event.id+':'+event.severity;
    const attempt=await repository.claim(id,event.severity);
    if(attempt===null) continue;
    const hash=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(id)))).map(b=>b.toString(16).padStart(2,'0')).join('');
    try {
      await deliverPolicyNotification({url:env.OPERATIONAL_POLICY_WEBHOOK_URL,token:env.OPERATIONAL_POLICY_WEBHOOK_TOKEN},event,hash,send);
      if(!await repository.settle(id,attempt,true)) throw Error('Policy notification lease lost');
      delivered++;
    } catch {
      await repository.settle(id,attempt,false);
      failed++;
    }
  }
  if(failed) throw Error('Policy notification delivery failed');
  return {status:'observed',delivered,readinessScanned:snapshot.readiness.length,cleanupScanned:snapshot.cleanup.length};
}
