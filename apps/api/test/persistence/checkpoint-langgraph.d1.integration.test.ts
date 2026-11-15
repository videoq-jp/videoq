import {afterEach,beforeEach,describe,expect,it} from "vitest";
import {StateGraph,StateSchema,MessagesValue,START,END,interrupt,Command} from "@langchain/langgraph";
import {HumanMessage,AIMessage} from "@langchain/core/messages";
import {emptyCheckpoint,type CheckpointMetadata} from "@langchain/langgraph-checkpoint";
import {z} from "zod";
import {createD1Fixture} from "./d1-fixture";
import {D1CheckpointSaver,D1CheckpointAccessError} from "../../src/persistence/d1/checkpoint-saver";
let f:Awaited<ReturnType<typeof createD1Fixture>>;
let leaseId:string;
const threadId='graph-thread';
const config={configurable:{thread_id:threadId}};
const metadata:CheckpointMetadata={source:'loop',step:0,parents:{}};
beforeEach(async()=>{
  f=await createD1Fixture();leaseId=crypto.randomUUID();
  await f.database.prepare("INSERT INTO users(id,username,email,is_over_quota,used_ai_answers,used_processing_seconds,used_storage_bytes) VALUES ('owner','owner','owner@example.test',0,0,0,0)").run();
  await f.database.prepare("INSERT INTO chat_conversations(thread_id,conversation_id,owner_user_id,lease_id,leased_until,expires_at) VALUES (?,?,?,?,'2099-01-01T00:00:00Z','2099-01-01T00:00:00Z')").bind(threadId,crypto.randomUUID(),'owner',leaseId).run();
});
afterEach(async()=>{await f?.dispose();});
const saver=()=>new D1CheckpointSaver(f.database,{threadId,leaseId});
describe('actual LangGraph on D1',()=>{
  const schema=new StateSchema({messages:MessagesValue,question:z.string()});
  const graph=(storage:D1CheckpointSaver)=>new StateGraph(schema).addNode('answer',state=>({messages:[new AIMessage(`seen:${state.messages.length}:${state.question}`)]}))
    .addEdge(START,'answer').addEdge('answer',END).compile({checkpointer:storage});
  it('resumes typed conversation state through a new saver instance and forks a chosen parent',async()=>{
    const first=saver();
    const result=await graph(first).invoke({question:'one',messages:[new HumanMessage('first')]},config);
    expect(result.messages).toHaveLength(2);
    const parent=(await first.getTuple(config))!.checkpoint.id;
    const next=saver();
    const continued=await graph(next).invoke({question:'two',messages:[new HumanMessage('second')]},config);
    expect(continued.messages).toHaveLength(4);
    const branch=await graph(saver()).invoke({question:'branch',messages:[new HumanMessage('branch')]},{configurable:{thread_id:threadId,checkpoint_id:parent}});
    expect(branch.messages).toHaveLength(4);
    expect(branch.messages.some(message=>message.content==='second')).toBe(false);
  });
  it('restores an interrupted graph without replacing it with chat history',async()=>{
    const build=(storage:D1CheckpointSaver)=>new StateGraph(new StateSchema({value:z.string().default('')}))
      .addNode('pause',()=>({value:interrupt<string,string>('choose a value')})).addEdge(START,'pause').addEdge('pause',END).compile({checkpointer:storage});
    const paused=await build(saver()).invoke({value:''},config);
    expect(paused).toHaveProperty('__interrupt__');
    const resumed=await build(saver()).invoke(new Command({resume:'chosen'}),config);
    expect(resumed.value).toBe('chosen');
  });
  it('fences expired/replaced leases, cross-thread access and deletion',async()=>{
    const old=saver();const saved=await old.put(config,emptyCheckpoint(),metadata,{});
    await old.putWrites(saved,[['value','saved write']],'task');
    await f.database.prepare("UPDATE chat_conversations SET leased_until='2000-01-01T00:00:00Z'").run();
    await expect(old.getTuple(config)).rejects.toBeInstanceOf(D1CheckpointAccessError);
    await f.database.prepare("UPDATE chat_conversations SET leased_until='2099-01-01T00:00:00Z'").run();
    await expect(old.getTuple({configurable:{thread_id:'other'}})).rejects.toBeInstanceOf(D1CheckpointAccessError);
    await f.database.prepare('UPDATE chat_conversations SET lease_id=?').bind(crypto.randomUUID()).run();
    await expect(old.put(config,emptyCheckpoint(),metadata,{})).rejects.toBeInstanceOf(D1CheckpointAccessError);
    await expect(old.getTuple(config)).rejects.toBeInstanceOf(D1CheckpointAccessError);
    await expect(old.deleteThread(threadId)).rejects.toBeInstanceOf(D1CheckpointAccessError);
    await f.database.prepare('DELETE FROM chat_conversations').run();
    expect(await f.database.prepare('SELECT count(*) AS n FROM conversation_checkpoints').first('n')).toBe(0);
    expect(await f.database.prepare('SELECT count(*) AS n FROM conversation_checkpoint_writes').first('n')).toBe(0);
  });
  it('rejects oversized state and rolls back intermediate writes on SQL failure',async()=>{
    const storage=saver();
    await expect(storage.put(config,{...emptyCheckpoint(),channel_values:{huge:'x'.repeat(1_800_001)}},metadata,{})).rejects.toThrow('budget');
    const checkpoint=await storage.put(config,emptyCheckpoint(),metadata,{});
    await f.database.prepare("CREATE TRIGGER fail_checkpoint_write BEFORE INSERT ON conversation_checkpoint_writes WHEN NEW.channel='fail' BEGIN SELECT RAISE(ABORT,'injected failure'); END").run();
    await expect(storage.putWrites(checkpoint,[['good',1],['fail',2]],'task')).rejects.toThrow();
    expect(await f.database.prepare('SELECT count(*) AS n FROM conversation_checkpoint_writes').first('n')).toBe(0);
    expect(await f.database.prepare('SELECT count(*) AS n FROM mutation_receipts').first('n')).toBe(0);
  });
});
