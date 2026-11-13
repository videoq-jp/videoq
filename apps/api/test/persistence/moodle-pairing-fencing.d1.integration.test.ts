import {afterEach,beforeEach,describe,expect,it} from 'vitest';
import {createD1Fixture} from './d1-fixture';
import {createD1MoodlePairingRepository} from '../../src/persistence/d1/moodle-pairing-repository';
import {digest,randomSecret} from '../../src/features/lti/store';
import {pairingCodeChallenge} from '../../src/shared/moodle-pairing-policy';
import type {PairingExchangeInput} from '../../src/persistence/contracts/moodle-pairing-repository';
import type {Bindings} from '../../src/types/bindings';
let f:Awaited<ReturnType<typeof createD1Fixture>>,env:Bindings;
beforeEach(async()=>{
  f=await createD1Fixture();env={DB:f.database,DEPLOYMENT_EDITION:'cloud',USE_S3_STORAGE:'true',USER_SECRET_ENCRYPTION_KEY:Buffer.alloc(32,7).toString('base64url'),LTI_CONFIG:JSON.stringify({toolOrigin:'https://api.example',databaseRegistrations:true,registrations:[]})} as Bindings;
  await f.database.prepare("INSERT INTO users(id,username,email,is_over_quota,used_ai_answers,used_processing_seconds,used_storage_bytes) VALUES('owner','owner','owner@example.test',0,0,0,0)").run();
});
afterEach(async()=>{await f?.dispose();});
const count=async(table:string)=>f.database.prepare(`SELECT count(*) AS n FROM ${table}`).first<number>('n');
function beforeBatch(number:number,operation:()=>Promise<void>):D1Database {
  let calls=0;
  return new Proxy(f.database,{
    get(target,key){
      if(key==='batch')return async(statements:D1PreparedStatement[])=>{if(++calls===number)await operation();return target.batch(statements);};
      const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value;
    },
  });
}
async function prepared(){
  const secret=randomSecret(),codeHash=await digest('moodle-pairing:'+secret),ownerKey=await digest('moodle-pairing-owner:owner'),receiptId=await digest('lti-materials-pairing:'+secret);
  const codeVerifier='v'.repeat(43),codeChallenge=await pairingCodeChallenge(codeVerifier);
  const issue={ownerUserId:'owner',ownerKey,codeHash,payload:{ownerUserId:'owner',moodleUrl:'https://lms.example',mode:'materials' as const,codeChallenge},expiresAt:Date.now()+600_000};
  const input:PairingExchangeInput={secret,issuer:'https://lms.example',clientId:'client',deploymentId:'2',mode:'materials',codeVerifier,materialsService:{tokenEndpoint:'https://lms.example/token',endpoint:'https://lms.example/materials'}};
  return {issue,input,codeHash,receiptId};
}
describe('D1 pairing fences after asynchronous preparation',()=>{
  it('does not save signing keys or codes if the account becomes inactive during RSA preparation',async()=>{
    const database=beforeBatch(1,async()=>{await f.database.prepare('UPDATE users SET is_active=0').run();});
    await expect(createD1MoodlePairingRepository(database,env).issue((await prepared()).issue)).rejects.toMatchObject({status:403});
    expect(await count('lti_tool_keys')).toBe(0);expect(await count('lti_credentials')).toBe(0);expect(await count('mutation_receipts')).toBe(0);
  });
  it('rejects a code whose payload changes after proof validation',async()=>{
    const p=await prepared();await createD1MoodlePairingRepository(f.database,env).issue(p.issue);
    const database=beforeBatch(2,async()=>{await f.database.prepare("UPDATE lti_credentials SET payload=json_set(payload,'$.codeChallenge',?) WHERE id=?").bind('x'.repeat(43),p.codeHash).run();});
    await expect(createD1MoodlePairingRepository(database,env).exchange(p.input,p.codeHash,p.receiptId)).rejects.toMatchObject({status:401});
    expect(await count('lms_installations')).toBe(0);expect(await count('lti_credentials')).toBe(2);expect(await count('mutation_receipts')).toBe(0);
  });
  it('rejects receipt replay if the connection is disconnected after the receipt was read',async()=>{
    const p=await prepared(),repository=createD1MoodlePairingRepository(f.database,env);await repository.issue(p.issue);await repository.exchange(p.input,p.codeHash,p.receiptId);
    const database=beforeBatch(2,async()=>{await f.database.prepare('UPDATE lms_installations SET active=0').run();});
    await expect(createD1MoodlePairingRepository(database,env).exchange(p.input,p.codeHash,p.receiptId)).rejects.toMatchObject({status:401});
    expect(await f.database.prepare('SELECT active FROM lms_installations').first('active')).toBe(0);expect(await count('mutation_receipts')).toBe(0);
  });
});
