import {createD1Fixture} from './d1-fixture';
import {courseContract,seedCourses} from './contracts/course.contract';
import {createCourseRepository} from '../../src/persistence/factory';
import type {Bindings} from '../../src/types/bindings';
courseContract('D1 workerd',async()=>{
  const f=await createD1Fixture();
  const execute=async(sql:string,args:unknown[]=[])=>{await f.database.prepare(sql).bind(...args.map(v=>typeof v==='boolean'?Number(v):v)).run();};
  // Seed required user fields using the actual SQLite schema.
  const seedExecute=async(sql:string,args:unknown[]=[])=>{
    if(sql==='INSERT INTO users(id) VALUES(?)')return execute('INSERT INTO users(id,username,email,is_over_quota,used_ai_answers,used_processing_seconds,used_storage_bytes) VALUES(?,?,?,0,0,0,0)',[args[0],args[0],`${String(args[0])}@example.test`]);
    return execute(sql,args);
  };
  try {
  await seedCourses(seedExecute);
  return {repository:await createCourseRepository({DB:f.database,DEPLOYMENT_EDITION:'cloud',USE_S3_STORAGE:'false'} as Bindings),execute,
    count:async(table:string)=>Number(await f.database.prepare(`SELECT count(*) AS n FROM ${table}`).first('n')),
    failCreate:()=>execute("CREATE TRIGGER fail_create BEFORE INSERT ON mcp_idempotency_records BEGIN SELECT RAISE(ABORT,'injected creation'); END"),
    failDelete:()=>execute("CREATE TRIGGER fail_delete BEFORE DELETE ON video_courses BEGIN SELECT RAISE(ABORT,'injected deletion'); END"),dispose:f.dispose};
  }catch(error){await f.dispose();throw error;}
});
