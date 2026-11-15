import {privacyContract} from './contracts/privacy.contract';
import {createD1PrivacyFixture} from './privacy-fixture.d1';
privacyContract('D1 workerd',async()=>{
 const f=await createD1PrivacyFixture();return {...f,inlineCheckpoint:true,
  count:async(table:string)=>{const name=table==='checkpoints'?'conversation_checkpoints':table==='checkpoint_writes'?'conversation_checkpoint_writes':table;return Number(await f.database.prepare(`SELECT count(*) AS n FROM ${name}`).first('n'));},
  failErase:()=>f.execute("CREATE TRIGGER erase_failure BEFORE DELETE ON lti_course_tag_operations BEGIN SELECT RAISE(ABORT,'erase failure'); END")};
});
