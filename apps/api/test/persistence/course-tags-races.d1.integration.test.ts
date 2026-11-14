import {expect,it} from 'vitest';
import {createD1Fixture} from './d1-fixture';
import {seedHistory} from './contracts/course-history.contract';
import {tagsScope} from './contracts/course-tags.contract';
import {courseTags} from '../../src/features/lti/course-tags';
import type {Bindings} from '../../src/types/bindings';
async function setup(){
 const f=await createD1Fixture(),env={DB:f.database,DEPLOYMENT_EDITION:'cloud'} as Bindings;
 const execute=async(sql:string,args:unknown[]=[])=>{await f.database.prepare(sql).bind(...args).run();};
 try{const seeded=await seedHistory(env,execute);await execute("UPDATE videos SET status='completed'");return {env,execute,...seeded,dispose:f.dispose};}catch(error){await f.dispose();throw error;}
}
function beforeCommit(database:D1Database,hook:()=>Promise<void>):D1Database{
 let calls=0;
 return new Proxy(database,{get(target,key){
  if(key==='batch')return async(statements:D1PreparedStatement[])=>{if(++calls===2)await hook();return target.batch(statements);};
  const value:unknown=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value;
 }});
}
it('rejects disconnection immediately before a D1 tag write without leaving a replay barrier',async()=>{
 const f=await setup();try{
  const database=f.env.DB!,scope=tagsScope(f);
  f.env.DB=beforeCommit(database,()=>f.execute("UPDATE lms_installations SET active=false WHERE id='school'"));
  await expect(courseTags(f.env,scope,{action:'create',operationId:crypto.randomUUID(),name:'Concept',color:'blue'})).rejects.toMatchObject({status:403});
  for(const table of ['lti_course_tags','lti_course_tag_operations','lti_operation_reservations','mutation_receipts'])expect(await database.prepare(`SELECT count(*) AS n FROM ${table}`).first('n')).toBe(0);
 }finally{await f.dispose();}
});
it('preserves a tag changed between D1 preparation and commit',async()=>{
 const f=await setup();try{
  const database=f.env.DB!,scope=tagsScope(f),tag=(await courseTags(f.env,scope,{action:'create',operationId:crypto.randomUUID(),name:'Concept',color:'blue'})).tags[0];
  f.env.DB=beforeCommit(database,()=>f.execute('UPDATE lti_course_tags SET name=?,revision=? WHERE id=?',['Newer name',crypto.randomUUID(),tag.id]));
  await expect(courseTags(f.env,scope,{action:'update',operationId:crypto.randomUUID(),id:tag.id,revision:tag.revision,name:'Old overwrite',color:'red'})).rejects.toMatchObject({status:409});
  expect(await database.prepare('SELECT name FROM lti_course_tags WHERE id=?').bind(tag.id).first('name')).toBe('Newer name');
  expect(await database.prepare('SELECT count(*) AS n FROM lti_operation_reservations').first('n')).toBe(1);
  expect(await database.prepare('SELECT count(*) AS n FROM mutation_receipts').first('n')).toBe(0);
 }finally{await f.dispose();}
});
