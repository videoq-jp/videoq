import {describe} from 'vitest';
import {privacyContract} from './contracts/privacy.contract';
import {createPostgresPrivacyFixture} from './privacy-fixture.postgres';
const url=process.env.PERSISTENCE_TEST_DATABASE_URL;
(url?describe:describe.skip)('PostgreSQL privacy',()=>{
 privacyContract('PostgreSQL',async()=>{
  const f=await createPostgresPrivacyFixture(url!);return {...f,inlineCheckpoint:false,
   count:async(table:string)=>{const name=['checkpoints','checkpoint_writes'].includes(table)?'chat_memory.'+table:table;return Number((await f.pool.query<{n:string}>(`SELECT count(*) AS n FROM ${name}`)).rows[0].n);},
   failErase:()=>f.execute("CREATE FUNCTION erase_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'erase failure'; END $$; CREATE TRIGGER erase_failure BEFORE DELETE ON lti_course_tag_operations FOR EACH ROW EXECUTE FUNCTION erase_fail()")};
 });
});
