import {describe} from "vitest";
import {PostgresSaver} from "@langchain/langgraph-checkpoint-postgres";
import {isolatedPostgres} from "./isolated-postgres";
import {checkpointContract} from "./contracts/checkpoint.contract";
const url=process.env.PERSISTENCE_TEST_DATABASE_URL;
(url?describe:describe.skip)('PostgresSaver checkpoint contract',()=>{
  checkpointContract('PostgresSaver',async()=>{
    const f=await isolatedPostgres(url!);const schema=`memory_${crypto.randomUUID().replaceAll('-','')}`;
    await f.pool.query(`CREATE SCHEMA "${schema}"`);
    const saver=new PostgresSaver(f.pool,undefined,{schema});await saver.setup();
    return{saver,threadId:'checkpoint-thread',dispose:async()=>{await f.pool.query(`DROP SCHEMA "${schema}" CASCADE`);await f.dispose();}};
  });
});
