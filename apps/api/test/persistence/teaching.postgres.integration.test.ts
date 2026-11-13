import {describe} from 'vitest';
import {generateDrizzleJson,generateMigration} from 'drizzle-kit/api';
import {users,videoCourses,lmsInstallations,ltiCredentials,teachingConnections} from '../../src/db/schema';
import {isolatedPostgres} from './isolated-postgres';
import {teachingContract,seedTeaching} from './contracts/teaching.contract';
import {createTeachingRepository} from '../../src/persistence/factory';
import type {Bindings} from '../../src/types/bindings';
const url=process.env.PERSISTENCE_TEST_DATABASE_URL;
(url?describe:describe.skip)('PostgreSQL teaching',()=>{
 teachingContract('PostgreSQL',async()=>{
  const f=await isolatedPostgres(url!);
  const execute=async(sql:string,args:unknown[]=[])=>{let i=0;await f.pool.query(sql.replaceAll('?',()=>`$${++i}`),args);};
  try{
   await execute((await generateMigration(generateDrizzleJson({}),generateDrizzleJson({users,videoCourses,lmsInstallations,ltiCredentials,teachingConnections}))).map(s=>s.replaceAll('"public".','')).join('\n'));
   await seedTeaching(execute);const env={DATABASE_POOL:f.pool,DEPLOYMENT_EDITION:'onprem'} as Bindings;
   return {env,repository:await createTeachingRepository(env),execute,failConnect:()=>execute("CREATE FUNCTION reject_teaching() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected failure'; END $$; CREATE TRIGGER reject_teaching BEFORE INSERT ON teaching_connections FOR EACH ROW EXECUTE FUNCTION reject_teaching()"),count:async(table:string)=>Number((await f.pool.query<{n:string}>(`SELECT count(*) AS n FROM ${table}`)).rows[0].n),dispose:f.dispose};
  }catch(error){await f.dispose();throw error;}
 });
});
