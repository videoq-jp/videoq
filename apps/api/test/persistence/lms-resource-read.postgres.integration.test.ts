import {describe} from 'vitest';
import {isolatedPostgres} from './isolated-postgres';
import {lmsResourceReadContract,seedLmsResourceRead} from './contracts/lms-resource-read.contract';
import type {Bindings} from '../../src/types/bindings';
const url=process.env.PERSISTENCE_TEST_DATABASE_URL;
(url?describe:describe.skip)('PostgreSQL LMS resource reads',()=>{
 lmsResourceReadContract('PostgreSQL',async()=>{
  const f=await isolatedPostgres(url!);const execute=async(sql:string,args:unknown[]=[])=>{let i=0;await f.pool.query(sql.replaceAll('?',()=>`$${++i}`),args);};
  try{
   await execute(`CREATE TABLE users(id text PRIMARY KEY,is_active boolean DEFAULT true,deactivated_at timestamptz,banned boolean DEFAULT false,ban_expires timestamptz);
    CREATE TABLE lms_installations(id text PRIMARY KEY,owner_user_id text REFERENCES users,name text,issuer text,client_id text,deployment_id text,authorization_url text,jwks_url text,sync_token_hash text,active boolean);
    CREATE TABLE video_courses(id bigint PRIMARY KEY,user_id text,name text,description text,display_order integer,created_at timestamptz,updated_at timestamptz,managed_by_lms boolean,native_access_disabled boolean);
    CREATE TABLE teaching_connections(id text PRIMARY KEY,provider text,installation_id text,context_id text,teacher_subject text,owner_user_id text,course_id bigint,active boolean);
    CREATE TABLE videos(id bigint PRIMARY KEY,user_id text,managed_by_lms boolean,transcription_language text,file text,multipart_upload jsonb,upload_heartbeat_at timestamptz,upload_usage_period_start timestamptz,title text,description text,uploaded_at timestamptz,transcript text,status text,error_message text,processing_seconds bigint,source_type text,source_url text,youtube_video_id text);
    CREATE TABLE lms_resources(id uuid PRIMARY KEY,installation_id text,external_id text,kind text,context_id text,resource_link_id text,generation bigint,manifest_hash text,enabled boolean,content_hash text,content_type text,file_size bigint,youtube_video_id text,course_id bigint,video_id bigint,sync_error text,updated_at timestamptz);`);
   await seedLmsResourceRead(execute);return {env:{DATABASE_POOL:f.pool,DEPLOYMENT_EDITION:'onprem'} as Bindings,execute,dispose:f.dispose};
  }catch(error){await f.dispose();throw error;}
 });
});
