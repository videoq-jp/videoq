import {describe} from 'vitest';
import {isolatedPostgres} from './isolated-postgres';
import {ltiRegistrationContract,seedLtiRegistrations} from './contracts/lti-registration.contract';
import type {Bindings} from '../../src/types/bindings';
const url=process.env.PERSISTENCE_TEST_DATABASE_URL;
(url?describe:describe.skip)('PostgreSQL LTI registrations',()=>{
  ltiRegistrationContract('PostgreSQL',async()=>{
    const f=await isolatedPostgres(url!);
    const execute=async(sql:string,args:unknown[]=[])=>{let i=0;await f.pool.query(sql.replaceAll('?',()=>`$${++i}`),args);};
    try{
      await execute(`CREATE TABLE users(id text PRIMARY KEY,is_active boolean DEFAULT true,deactivated_at timestamptz,banned boolean DEFAULT false,ban_expires timestamptz);
        CREATE TABLE video_courses(id bigint PRIMARY KEY,user_id text,name text,description text,display_order integer,created_at timestamptz,updated_at timestamptz,managed_by_lms boolean,native_access_disabled boolean);
        CREATE TABLE videos(id bigint PRIMARY KEY,user_id text,title text,description text,file text,uploaded_at timestamptz,transcript text,status text,error_message text,source_type text,source_url text,youtube_video_id text,managed_by_lms boolean);
        CREATE TABLE lms_installations(id text PRIMARY KEY,owner_user_id text,name text,issuer text,client_id text,deployment_id text,authorization_url text,jwks_url text,materials_service jsonb,sync_token_hash text,active boolean);
        CREATE TABLE video_course_members(id serial PRIMARY KEY,course_id bigint,video_id bigint,"order" integer,added_at timestamptz);
        CREATE TABLE teaching_connections(id text PRIMARY KEY,provider text,installation_id text,context_id text,teacher_subject text,resource_link_id text,owner_user_id text,course_id bigint,active boolean);
        CREATE TABLE lms_resources(id text PRIMARY KEY,installation_id text,external_id text,kind text,context_id text,resource_link_id text,generation integer,manifest_hash text,enabled boolean,course_id bigint,video_id bigint,youtube_video_id text);`);
      await seedLtiRegistrations(execute);
      return {env:{DATABASE_POOL:f.pool,DEPLOYMENT_EDITION:'onprem',LTI_CONFIG:JSON.stringify({toolOrigin:'https://api.example',databaseRegistrations:true,registrations:[]})} as Bindings,execute,dispose:f.dispose};
    }catch(error){await f.dispose();throw error;}
  });
});
