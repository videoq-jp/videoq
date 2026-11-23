import { DurableObject } from 'cloudflare:workers';
import { verifyIdentity, verifyStart, boundedJson } from './auth.mjs';
import { CoordinatorStore, runKey } from './coordinator.mjs';
export class MaintenanceCoordinator extends DurableObject {
  #store;
  constructor(ctx,env) { super(ctx,env); this.#store = new CoordinatorStore(ctx.storage); }
  async operate(identity, body, githubToken) {
    if (identity.access === 'status') {
      if (body.action !== 'status' || Object.keys(body).length !== 1) throw Error('INVALID_MAINTENANCE_ACTION');
      await verifyStart(identity,githubToken); return this.#store.status();
    }
    const id = await runKey(identity);
    if (body.action === 'acquire') await verifyStart(identity,githubToken,{recovery:this.#store.recovery(id,identity)});
    return this.#store.operate(id,identity,body);
  }
}
export default {
  async fetch(request, env) {
    const url = new URL(request.url), headers = { 'cache-control':'no-store' };
    if (request.method === 'GET' && url.pathname === '/health') return Response.json({ status:'ok',enabled:env.MAINTENANCE_ENABLED === 'true' },{headers});
    const statusKind = /^\/v1\/status\/(migration|smoke)$/.exec(url.pathname)?.[1];
    if (env.MAINTENANCE_ENABLED !== 'true' && !statusKind) return Response.json({error:'MAINTENANCE_DISABLED'},{status:503,headers});
    const kind = statusKind ?? /^\/v1\/(migration|smoke)$/.exec(url.pathname)?.[1];
    if (!kind || request.method !== 'POST') return Response.json({error:'NOT_FOUND'},{status:404,headers});
    try {
      if (request.headers.get('content-type')?.split(';')[0] !== 'application/json') throw Error('INVALID_MAINTENANCE_REQUEST');
      const identity = await verifyIdentity(request.headers.get('authorization')?.replace(/^Bearer /,''),kind,{statusOnly:Boolean(statusKind)});
      const body = await boundedJson(new Response(request.body),70000);
      const result = await env.MAINTENANCE.getByName('videoq-prod-db').operate(identity,body,request.headers.get('x-github-token'));
      return Response.json(result,{headers});
    } catch (error) {
      const name = error instanceof Error ? error.message:'';
      const exposed = /^(MAINTENANCE_(BUSY|OWNERSHIP_REQUIRED|NOT_RUNNING|RECOVERY_REQUIRED|RUN_CHANGED|PLAN_IMMUTABLE|PLAN_TOO_LARGE|COMPLETION_PROOF_REQUIRED)|INVALID_MAINTENANCE_(ACTION|REQUEST|PLAN)|OIDC_REQUIRED|GITHUB_RUN_REQUIRED|MAIN_CI_REQUIRED|CANONICAL_MAIN_REQUIRED)$/.test(name) ? name:'MAINTENANCE_REQUEST_REFUSED';
      return Response.json({error:exposed},{status:exposed.startsWith('MAINTENANCE_')?409:403,headers});
    }
  },
};
