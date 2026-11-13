import {describe} from 'vitest';
import {isolatedPostgres} from './isolated-postgres';
import {moodlePairingContract} from './contracts/moodle-pairing.contract';
import type {Bindings} from '../../src/types/bindings';
const url=process.env.PERSISTENCE_TEST_DATABASE_URL;
(url?describe:describe.skip)('PostgreSQL Moodle pairing',()=>{
  moodlePairingContract('PostgreSQL',async()=>{
    const f=await isolatedPostgres(url!);const execute=async(sql:string,args:unknown[]=[])=>{let i=0;await f.pool.query(sql.replaceAll('?',()=>`$${++i}`),args);};
    try{
      await execute(`CREATE TABLE users(id text PRIMARY KEY,is_active boolean DEFAULT true,deactivated_at timestamptz,banned boolean DEFAULT false,ban_expires timestamptz);
        INSERT INTO users VALUES('owner'),('other');
        CREATE TABLE lti_credentials(id text PRIMARY KEY,kind text,payload jsonb,expires_at timestamptz);
        CREATE TABLE lti_tool_keys(id text PRIMARY KEY,encrypted_key_ring text NOT NULL,created_at timestamptz DEFAULT now());
        CREATE TABLE lms_installations(id text PRIMARY KEY,owner_user_id text REFERENCES users,name text,issuer text,client_id text,deployment_id text,authorization_url text,jwks_url text,sync_token_hash text,materials_service jsonb,active boolean DEFAULT true,next_materials_sync_at timestamptz DEFAULT now(),materials_cursor integer DEFAULT 0,created_at timestamptz DEFAULT now(),UNIQUE(issuer,client_id));
        CREATE TABLE mutation_receipts(token text);`);
      return {env:{DATABASE_POOL:f.pool,DEPLOYMENT_EDITION:'onprem',USE_S3_STORAGE:'true',USER_SECRET_ENCRYPTION_KEY:Buffer.alloc(32,7).toString('base64url'),LTI_CONFIG:JSON.stringify({toolOrigin:'https://api.example',databaseRegistrations:true,registrations:[]})} as Bindings,execute,
        count:async(table:string)=>Number((await f.pool.query<{n:string}>(`SELECT count(*) AS n FROM ${table}`)).rows[0].n),
        syncHash:async()=>(await f.pool.query<{sync_token_hash:string|null}>('SELECT sync_token_hash FROM lms_installations LIMIT 1')).rows[0]?.sync_token_hash??null,
        credential:async(id:string)=>(await f.pool.query<{kind:string;payload:Record<string,unknown>}>('SELECT kind,payload FROM lti_credentials WHERE id=$1',[id])).rows[0]??null,
        failIssue:()=>execute("ALTER TABLE lti_credentials ADD CONSTRAINT fail_issue CHECK(kind<>'moodle-pairing')"),
        failExchange:()=>execute("ALTER TABLE lti_credentials ADD CONSTRAINT fail_exchange CHECK(kind<>'materials-pairing')"),
        allowExchange:()=>execute('ALTER TABLE lti_credentials DROP CONSTRAINT fail_exchange'),dispose:f.dispose};
    }catch(error){await f.dispose();throw error;}
  });
});
