import {generateDrizzleJson,generateMigration} from 'drizzle-kit/api';
import {users,lmsInstallations,ltiCredentials,ltiToolKeys,videoCourses,teachingConnections} from '../../src/db/schema';
import {describe} from 'vitest';
import {isolatedPostgres} from './isolated-postgres';
import {lmsInstallationContract} from './contracts/lms-installation.contract';
import type {Bindings} from '../../src/types/bindings';
const url=process.env.PERSISTENCE_TEST_DATABASE_URL;
(url?describe:describe.skip)('PostgreSQL LMS installation',()=>{
 lmsInstallationContract('PostgreSQL',async()=>{
  const f=await isolatedPostgres(url!);const execute=async(sql:string,args:unknown[]=[])=>{let i=0;await f.pool.query(sql.replaceAll('?',()=>`$${++i}`),args);};
  try{
   const statements=await generateMigration(generateDrizzleJson({}),generateDrizzleJson({users,lmsInstallations,ltiCredentials,ltiToolKeys,videoCourses,teachingConnections}));
   await execute(statements.map(statement=>statement.replaceAll('"public".','')).join('\n'));
   for(const id of ['owner','other'])await execute('INSERT INTO users(id,username,email,is_over_quota,used_ai_answers,used_processing_seconds,used_storage_bytes) VALUES(?,?,?,false,0,0,0)',[id,id,`${id}@example.test`]);
   await execute('CREATE TABLE mutation_receipts(token text)');
   return {env:{DATABASE_POOL:f.pool,DEPLOYMENT_EDITION:'onprem',USE_S3_STORAGE:'true',USER_SECRET_ENCRYPTION_KEY:Buffer.alloc(32,7).toString('base64url'),LTI_CONFIG:JSON.stringify({toolOrigin:'https://api.example',databaseRegistrations:true,registrations:[]})} as Bindings,execute,
    count:async(table:string)=>Number((await f.pool.query<{n:string}>(`SELECT count(*) AS n FROM ${table}`)).rows[0].n),
    hash:async(id:string)=>(await f.pool.query<{hash:string|null}>('SELECT sync_token_hash AS hash FROM lms_installations WHERE id=$1',[id])).rows[0]?.hash??null,
    failDisconnect:()=>execute("CREATE FUNCTION fail_disconnect() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF OLD.kind='moodle-pairing' THEN RAISE EXCEPTION 'injected revoke'; END IF; RETURN OLD; END $$; CREATE TRIGGER fail_disconnect BEFORE DELETE ON lti_credentials FOR EACH ROW EXECUTE FUNCTION fail_disconnect()"),dispose:f.dispose};
  }catch(error){await f.dispose();throw error;}
 });
});
