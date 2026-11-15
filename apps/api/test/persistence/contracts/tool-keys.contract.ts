import {afterEach,beforeEach,describe,expect,it} from 'vitest';
import {createLocalJWKSet,jwtVerify} from 'jose';
import {ensureManagedToolKeys,toolClientAssertion,toolJwks} from '../../../src/features/lti/tool-keys';
import {generateEncryptedToolKeyRing,parseStoredToolKeyRing} from '../../../src/shared/lti-tool-keyring';
import {createToolKeyRepository} from '../../../src/persistence/factory';
import type {Bindings} from '../../../src/types/bindings';
type Fixture={env:Bindings;execute:(sql:string,args?:unknown[])=>Promise<void>;count:()=>Promise<number>;dispose:()=>Promise<void>};
export function toolKeysContract(name:string,setup:()=>Promise<Fixture>){
  describe(`${name} signing-key contract`,()=>{
    let f:Fixture;beforeEach(async()=>{f=await setup();});afterEach(async()=>{await f?.dispose();});
    it('initializes one encrypted key across concurrent replicas and publishes only public components',async()=>{
      expect(await toolJwks(f.env)).toEqual({keys:[]});
      await Promise.all([ensureManagedToolKeys(f.env),ensureManagedToolKeys({...f.env})]);
      expect(await f.count()).toBe(1);
      const cipher=await (await createToolKeyRepository(f.env)).readEncrypted();expect(cipher).toMatch(/^v2\./);expect(cipher).not.toContain('"d"');
      const first=await toolJwks(f.env);expect(first.keys).toHaveLength(1);
      expect(Object.keys(first.keys[0]).sort()).toEqual(['alg','e','kid','kty','n','use']);
      await ensureManagedToolKeys({...f.env});expect(await toolJwks({...f.env})).toEqual(first);
    });
    it('signs verifiable short-lived client assertions using the persisted key',async()=>{
      await ensureManagedToolKeys(f.env);
      const first=await toolClientAssertion(f.env,'client','deployment','https://lms.example/token');
      const second=await toolClientAssertion({...f.env},'client','deployment','https://lms.example/token');
      const keys=createLocalJWKSet(await toolJwks(f.env));
      const {payload,protectedHeader}=await jwtVerify(first,keys,{issuer:'client',audience:'https://lms.example/token',algorithms:['RS256']});
      expect(payload.sub).toBe('client');expect(payload['https://purl.imsglobal.org/spec/lti/claim/deployment_id']).toBe('deployment');
      expect(payload.exp!-payload.iat!).toBe(60);expect(protectedHeader.kid).toBe((await toolJwks(f.env)).keys[0].kid);
      expect((await jwtVerify(second,keys)).payload.jti).not.toBe(payload.jti);
    });
    it('keeps static key configuration independent of persistence and deduplicates old public keys',async()=>{
      const ring=await parseStoredToolKeyRing(f.env,await generateEncryptedToolKeyRing(f.env));
      const current=ring.current;
      const env={LTI_TOOL_KEYS:JSON.stringify({...ring,previous:[{kty:current.kty,n:current.n,e:current.e}]})} as Bindings;
      await ensureManagedToolKeys(env);expect((await toolJwks(env)).keys).toHaveLength(1);expect(await f.count()).toBe(0);
      await expect(toolJwks({LTI_TOOL_KEYS:JSON.stringify({...ring,current:{...current,n:'short'}})})).rejects.toThrow('Invalid LTI tool signing-key configuration');
    });
    it('fails closed for missing encryption, corrupt storage and a changed encryption key',async()=>{
      const noSecret={...f.env,USER_SECRET_ENCRYPTION_KEY:undefined};
      expect(await toolJwks(noSecret)).toEqual({keys:[]});await expect(ensureManagedToolKeys(noSecret)).rejects.toThrow('LTI signing keys are unavailable');
      await ensureManagedToolKeys(f.env);
      await expect(toolJwks({...f.env,USER_SECRET_ENCRYPTION_KEY:Buffer.alloc(32,99).toString('base64url')})).rejects.toThrow('LTI signing keys could not be loaded');
      await f.execute("UPDATE lti_tool_keys SET encrypted_key_ring='corrupt-sensitive-value'");
      await expect(toolJwks(f.env)).rejects.toThrow('LTI signing keys could not be loaded');
      await expect(ensureManagedToolKeys(f.env)).rejects.toThrow('LTI signing-key initialization failed');
    });
  });
}
