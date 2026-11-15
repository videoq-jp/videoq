import {createD1Fixture} from './d1-fixture';
import {courseTagsContract} from './contracts/course-tags.contract';
import {seedHistory} from './contracts/course-history.contract';
import type {Bindings} from '../../src/types/bindings';
async function setup(){
 const f=await createD1Fixture(),env={DB:f.database,DEPLOYMENT_EDITION:'cloud'} as Bindings;
 const execute=async(sql:string,args:unknown[]=[])=>{await f.database.prepare(sql).bind(...args).run();};
 try{const seeded=await seedHistory(env,execute);return {env,execute,...seeded,dispose:f.dispose,
  count:async(table:'lti_course_tag_operations'|'lti_operation_reservations'|'lti_course_video_tags'|'mutation_receipts')=>Number(await f.database.prepare(`SELECT count(*) AS n FROM ${table}`).first('n')),
  failOperation:()=>execute("CREATE TRIGGER fail_tag_receipt BEFORE INSERT ON lti_course_tag_operations BEGIN SELECT RAISE(ABORT,'receipt failure'); END"),
  seedTags:(count:number)=>execute('INSERT INTO lti_course_tags(id,course_id,name,color,revision) SELECT json_extract(value,\'$.id\'),?,json_extract(value,\'$.name\'),\'gray\',json_extract(value,\'$.revision\') FROM json_each(?)',[seeded.courseId,JSON.stringify(Array.from({length:count},(_,i)=>({id:crypto.randomUUID(),revision:crypto.randomUUID(),name:`Tag ${i}`})))])};
 }catch(error){await f.dispose();throw error;}
}
courseTagsContract('D1 workerd',setup);
