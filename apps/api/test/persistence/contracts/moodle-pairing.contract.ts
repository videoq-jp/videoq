import {issueMoodlePairing,exchangeMoodlePairing} from '../../../src/features/lms/pairing';
import {afterEach,beforeEach,describe,expect,it} from 'vitest';
import {digest,randomSecret} from '../../../src/features/lti/store';
import {pairingCodeChallenge} from '../../../src/shared/moodle-pairing-policy';
import {createMoodlePairingRepository} from '../../../src/persistence/factory';
import {toolJwks} from '../../../src/features/lti/tool-keys';
import type {Bindings} from '../../../src/types/bindings';
import type {PairingMode,PairingExchangeInput} from '../../../src/persistence/contracts/moodle-pairing-repository';
type Fixture={env:Bindings;execute:(sql:string,args?:unknown[])=>Promise<void>;count:(table:string)=>Promise<number>;syncHash:()=>Promise<string|null>;credential:(id:string)=>Promise<{kind:string;payload:Record<string,unknown>}|null>;failIssue:()=>Promise<void>;failExchange:()=>Promise<void>;allowExchange:()=>Promise<void>;dispose:()=>Promise<void>};
export function moodlePairingContract(name:string,setup:()=>Promise<Fixture>){
  describe(`${name} Moodle pairing contract`,()=>{
    let f:Fixture;beforeEach(async()=>{f=await setup();});afterEach(async()=>{await f?.dispose();});
    const issuer='https://lms.example';
    const verifier='v'.repeat(43);
    const issue=async(ownerUserId='owner',mode:PairingMode='materials',challenge?:string)=>{
      const secret=randomSecret(),codeHash=await digest('moodle-pairing:'+secret),ownerKey=await digest('moodle-pairing-owner:'+ownerUserId),receiptId=await digest('lti-materials-pairing:'+secret);
      await (await createMoodlePairingRepository(f.env)).issue({ownerUserId,codeHash,ownerKey,payload:{ownerUserId,moodleUrl:issuer,mode,...(challenge?{codeChallenge:challenge}:{})},expiresAt:Date.now()+600_000});
      const input:PairingExchangeInput={secret,issuer,clientId:'client',deploymentId:'2',mode,...(mode==='materials'?{materialsService:{tokenEndpoint:issuer+'/token',endpoint:issuer+'/materials'}}:{syncToken:'a'.repeat(64)})};
      return {secret,codeHash,ownerKey,receiptId,input};
    };
    type Code=Awaited<ReturnType<typeof issue>>;
    const exchange=async(code:Code,patch:Partial<PairingExchangeInput>={})=>(await createMoodlePairingRepository(f.env)).exchange({...code.input,...patch},code.codeHash,code.receiptId);
    it('issues only hashed credentials, initializes encrypted signing keys and invalidates older owner pointers',async()=>{
      const old=await issue();const current=await issue();
      expect((await f.credential(current.ownerKey))?.payload).toEqual({codeHash:current.codeHash});
      expect(JSON.stringify(await f.credential(current.codeHash))).not.toContain(current.secret);
      expect(await f.count('lti_tool_keys')).toBe(1);expect((await toolJwks(f.env)).keys).toHaveLength(1);
      await expect(exchange(old)).rejects.toMatchObject({status:401,code:'INVALID_PAIRING_CODE'});
      expect(await exchange(current)).toMatchObject({ownerUserId:'owner'});
      expect(await f.count('mutation_receipts')).toBe(0);
    });
    it('serializes simultaneous first-time issuance and retains just the latest owner pointer',async()=>{
      const codes=await Promise.all([issue(),issue()]);
      expect(await f.count('lti_tool_keys')).toBe(1);
      const outcomes=await Promise.allSettled(codes.map(code=>exchange(code)));
      expect(outcomes.filter(r=>r.status==='fulfilled')).toHaveLength(1);expect(await f.count('lms_installations')).toBe(1);
    });
    it('consumes one legacy code once and stores only the sync token digest',async()=>{
      const code=await issue('owner','legacy');
      const results=await Promise.allSettled([exchange(code),exchange(code)]);
      expect(results.filter(r=>r.status==='fulfilled')).toHaveLength(1);
      const rejected=results.find(r=>r.status==='rejected');expect(rejected?.status==='rejected'?rejected.reason:undefined).toMatchObject({status:401,code:'INVALID_PAIRING_CODE'});
      expect(await f.count('lms_installations')).toBe(1);expect(await f.credential(code.codeHash)).toBeNull();expect(await f.credential(code.ownerKey)).toBeNull();
      expect(await f.count('lti_tool_keys')).toBe(0);expect(await f.syncHash()).toBe(await digest(code.input.syncToken!));
    });
    it('replays materials exchange after commit and safely handles overlapping replicas',async()=>{
      const code=await issue('owner','materials',await pairingCodeChallenge(verifier));
      const results=await Promise.all([exchange(code,{codeVerifier:verifier}),exchange(code,{codeVerifier:verifier})]);
      expect(results[0]).toEqual(results[1]);expect(await f.count('lms_installations')).toBe(1);
      expect(await exchange(code,{codeVerifier:verifier})).toEqual(results[0]);
      expect(await f.credential(code.codeHash)).toBeNull();expect((await f.credential(code.receiptId))?.kind).toBe('materials-pairing');
      await expect(exchange(code,{codeVerifier:'x'.repeat(43)})).rejects.toMatchObject({status:401});
      await expect(exchange(code,{clientId:'different',codeVerifier:verifier})).rejects.toMatchObject({status:401});
    });
    it('refuses incorrect proof, issuer and mode without consuming the code',async()=>{
      const code=await issue('owner','materials',await pairingCodeChallenge(verifier));
      for(const patch of [{codeVerifier:'x'.repeat(43)},{issuer:'https://different.example',codeVerifier:verifier},{mode:'legacy' as const,syncToken:'a'.repeat(64)}])
        await expect(exchange(code,patch)).rejects.toMatchObject({status:401});
      expect(await f.credential(code.codeHash)).not.toBeNull();
      expect(await exchange(code,{codeVerifier:verifier})).toMatchObject({ownerUserId:'owner'});
    });
    it('rejects inactive owners and expired codes and pointers',async()=>{
      await f.execute('UPDATE users SET is_active=? WHERE id=?',[false,'owner']);
      await expect(issue()).rejects.toMatchObject({status:403,code:'INACTIVE_ACCOUNT'});expect(await f.count('lti_credentials')).toBe(0);expect(await f.count('lti_tool_keys')).toBe(0);
      await f.execute('UPDATE users SET is_active=? WHERE id=?',[true,'owner']);const code=await issue();
      await f.execute('UPDATE users SET is_active=? WHERE id=?',[false,'owner']);await expect(exchange(code)).rejects.toMatchObject({status:403});
      await f.execute('UPDATE users SET is_active=? WHERE id=?',[true,'owner']);
      await f.execute('UPDATE lti_credentials SET expires_at=? WHERE id=?',['2000-01-01',code.ownerKey]);await expect(exchange(code)).rejects.toMatchObject({status:401});
      const expired=await issue();await f.execute('UPDATE lti_credentials SET expires_at=? WHERE id=?',['2000-01-01',expired.codeHash]);await expect(exchange(expired)).rejects.toMatchObject({status:401});
    });
    it('reconnects only the same owner in materials mode and does not consume conflicts',async()=>{
      const first=await exchange(await issue());const next=await issue();
      expect(await exchange(next,{deploymentId:'3'})).toEqual(first);
      const other=await issue('other');await expect(exchange(other)).rejects.toMatchObject({status:409,code:'CONNECTION_EXISTS'});expect(await f.credential(other.codeHash)).not.toBeNull();
      const legacy=await issue('owner','legacy');await expect(exchange(legacy)).rejects.toMatchObject({status:409});expect(await f.credential(legacy.codeHash)).not.toBeNull();
    });
    it('rejects a competing owner with a business conflict while retaining the losing code',async()=>{
      const codes=await Promise.all([issue('owner'),issue('other')]);
      const outcomes=await Promise.allSettled(codes.map(code=>exchange(code)));
      expect(outcomes.filter(r=>r.status==='fulfilled')).toHaveLength(1);
      const loser=outcomes.findIndex(r=>r.status==='rejected');const rejected=outcomes[loser];
      expect(rejected.status==='rejected'?rejected.reason:undefined).toMatchObject({status:409,code:'CONNECTION_EXISTS'});
      expect(await f.credential(codes[loser].codeHash)).not.toBeNull();expect(await f.count('lms_installations')).toBe(1);
    });
    it('does not reactivate a disconnected receipt or a pending code with a revoked owner pointer',async()=>{
      const code=await issue();await exchange(code);
      await f.execute('UPDATE lms_installations SET active=?',[false]);await expect(exchange(code)).rejects.toMatchObject({status:401});
      const pending=await issue();await f.execute('DELETE FROM lti_credentials WHERE id=?',[pending.ownerKey]);
      await expect(exchange(pending)).rejects.toMatchObject({status:401});
    });
    it('rolls back key initialization and code issuance if the owner pointer cannot be saved',async()=>{
      await f.failIssue();await expect(issue()).rejects.toThrow();
      expect(await f.count('lti_credentials')).toBe(0);expect(await f.count('lti_tool_keys')).toBe(0);expect(await f.count('mutation_receipts')).toBe(0);
    });
    it('rolls back installation and credential changes if the retry receipt cannot be saved',async()=>{
      const code=await issue();await f.failExchange();await expect(exchange(code)).rejects.toThrow();
      expect(await f.count('lms_installations')).toBe(0);expect(await f.credential(code.codeHash)).not.toBeNull();expect(await f.credential(code.ownerKey)).not.toBeNull();
      expect(await f.count('mutation_receipts')).toBe(0);await f.allowExchange();expect(await exchange(code)).toMatchObject({ownerUserId:'owner'});
    });
    it('runs the shared pairing workflow and recovers if upload policy generation fails after commit',async()=>{
      const scheduler={getByName:()=>({armAt:()=>Promise.resolve()})};
      const env={...f.env,TASK_SCHEDULER:scheduler} as unknown as Bindings;
      const issued=await issueMoodlePairing(env,'owner',issuer,'https://api.example',await pairingCodeChallenge(verifier));
      expect(issued.code).toMatch(/^VIDEOQ2\./);
      const decoded=JSON.parse(atob(issued.code.slice('VIDEOQ2.'.length))) as {origin:string;secret:string};expect(decoded.origin).toBe('https://api.example');
      const input={secret:decoded.secret,issuer,clientId:'client',deploymentId:'2',mode:'materials' as const,codeVerifier:verifier,
        materialsService:{tokenEndpoint:issuer+'/token',endpoint:issuer+'/materials'}};
      await expect(exchangeMoodlePairing(env,input)).rejects.toThrow();expect(await f.count('lms_installations')).toBe(1);
      const configured={...env,R2_ACCESS_KEY_ID:'fixture',R2_SECRET_ACCESS_KEY:'fixture',R2_S3_ENDPOINT:'https://storage.example',R2_BUCKET_NAME:'bucket'};
      const replay=await exchangeMoodlePairing(configured,input);
      expect(replay).toMatchObject({toolOrigin:'https://api.example',uploadTargets:[{origin:'https://storage.example',prefix:'/bucket/media/videos/'}]});
      expect(await f.count('lms_installations')).toBe(1);
    });

  });
}
