import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../../../src/app';
import { listConnectedApps, listIntegrationApiKeys } from '../../../src/repositories/account-integrations-repository';
import { TEST_USER_ID, testAuthHeaders } from '../../helpers/auth';
import type { Bindings } from '../../../src/types/bindings';
export type IntegrationsFixture = { env: Bindings; execute(sql: string, args?: unknown[]): Promise<void>; dispose(): Promise<void> };
export function accountIntegrationsContract(name: string, setup: () => Promise<IntegrationsFixture>) {
  describe(`${name} account integration metadata`, () => {
    let f: IntegrationsFixture;
    beforeEach(async () => {
      f = await setup();
      Object.assign(f.env, { ENVIRONMENT: 'development', BETTER_AUTH_URL: 'https://integrations-test.example', BETTER_AUTH_SECRET: 'isolated-integration-test-secret-012345678901234567890' });
      for (const id of [TEST_USER_ID, 'peer']) await f.execute('INSERT INTO users(id,username,email,is_over_quota,used_ai_answers,used_processing_seconds,used_storage_bytes) VALUES(?,?,?,?,0,0,0)', [id,id,`${id}@example.test`,false]);
    });
    afterEach(async () => { await f?.dispose(); });
    const key = (id: string, owner = TEST_USER_ID, config = 'default', permissions: string | null = '{"videoq":["read"]}') =>
      f.execute('INSERT INTO apikey(id,reference_id,config_id,key,permissions,created_at,updated_at) VALUES(?,?,?,?,?,?,?)', [id,owner,config,'private-key-hash',permissions,'2026-09-01T00:00:00.000Z','2026-09-01T00:00:00.000Z']);
    const client = () => f.execute('INSERT INTO oauth_client(id,client_id,name,client_secret,redirect_uris) VALUES(?,?,?,?,?)', ['client-row','client','Learning app','private-client-secret',[]]);
    const consent = (id: string, owner = TEST_USER_ID, scopes: string[] = ['videoq.read'], date: string | null = '2026-09-01T00:00:00.000Z') =>
      f.execute('INSERT INTO oauth_consent(id,client_id,user_id,scopes,created_at) VALUES(?,?,?,?,?)', [id,'client',owner,scopes,date]);
    it('returns all 105 owned keys through tRPC, excludes other profiles and secrets, and orders ties consistently', async () => {
      for (let i=0;i<105;i++) await key(`key-${String(i).padStart(3,'0')}`);
      await key('foreign','peer');await key('organization',TEST_USER_ID,'organization');
      await f.execute("UPDATE apikey SET start='vq_preview',created_at='2026-09-02T00:00:00Z' WHERE id='key-104'");
      const response = await createApp().request('/api/trpc/account.integrationApiKeys', {headers:testAuthHeaders()}, f.env);
      expect(response.status).toBe(200);
      const body = await response.json<{result:{data:Awaited<ReturnType<typeof listIntegrationApiKeys>>}}>();
      expect(body.result.data.map(r=>r.id)).toEqual(['key-104',...Array.from({length:104},(_,i)=>`key-${String(i).padStart(3,'0')}`)]);
      expect(body.result.data[0]).toEqual({id:'key-104',config_id:'default',name:'',prefix:'vq_preview',access_level:'read_only',last_used_at:null,created_at:'2026-09-02T00:00:00.000Z'});
      expect(JSON.stringify(body)).not.toContain('private-');
    });
    it.each([{value:'{"videoq":["read","write"]}',level:'all'},{value:'{"videoq":["write"]}',level:'read_only'},{value:'invalid-json',level:'read_only'},{value:null,level:'read_only'}])('normalizes permissions and optional fields ($value)', async ({value,level})=>{
      await key('key',TEST_USER_ID,'read-write',value);
      await f.execute("UPDATE apikey SET prefix='custom_',last_request='2026-09-02T09:00:00+09:00' WHERE id='key'");
      expect(await listIntegrationApiKeys(f.env,TEST_USER_ID)).toEqual([{id:'key',config_id:'read-write',name:'',prefix:'custom_',access_level:level,last_used_at:'2026-09-02T00:00:00.000Z',created_at:'2026-09-01T00:00:00.000Z'}]);
    });
    it('returns all OAuth grants, isolates ownership, normalizes JSON scopes and preserves unknown-date ordering', async()=>{
      await client();for(let i=0;i<105;i++)await consent(`grant-${String(i).padStart(3,'0')}`);
      await consent('foreign','peer',['videoq.write']);await consent('unknown',TEST_USER_ID,['videoq.read','videoq.write'],null);
      const response=await createApp().request('/api/trpc/account.connectedApps',{headers:testAuthHeaders()},f.env);
      expect(response.status).toBe(200);const body=await response.json<{result:{data:Awaited<ReturnType<typeof listConnectedApps>>}}>();
      expect(body.result.data.map(r=>r.id)).toEqual(['unknown',...Array.from({length:105},(_,i)=>`grant-${String(i).padStart(3,'0')}`)]);
      expect(body.result.data[0]).toEqual({id:'unknown',client_id:'client',client_name:'Learning app',scope:'videoq.read videoq.write',issued_at:null});expect(JSON.stringify(body)).not.toContain('private-');
      await f.execute("UPDATE oauth_client SET name='' WHERE client_id='client'");
      expect((await listConnectedApps(f.env,TEST_USER_ID))[0].client_name).toBe('client');
    });
    it('returns empty lists for unrelated accounts',async()=>{
      await key('key','peer');await client();await consent('grant','peer');
      expect(await listIntegrationApiKeys(f.env,TEST_USER_ID)).toEqual([]);expect(await listConnectedApps(f.env,TEST_USER_ID)).toEqual([]);
    });
  });
}
