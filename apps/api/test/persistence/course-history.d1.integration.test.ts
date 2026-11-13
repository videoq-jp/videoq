import {createD1Fixture} from './d1-fixture';
import {courseHistoryContract,seedHistory} from './contracts/course-history.contract';
import type {Bindings} from '../../src/types/bindings';
courseHistoryContract('D1 workerd',async()=>{
 const f=await createD1Fixture(),env={DB:f.database,DEPLOYMENT_EDITION:'cloud'} as Bindings;
 const execute=async(sql:string,args:unknown[]=[])=>{await f.database.prepare(sql).bind(...args).run();};
 try{return {env,execute,...await seedHistory(env,execute),dispose:f.dispose};}catch(error){await f.dispose();throw error;}
});
