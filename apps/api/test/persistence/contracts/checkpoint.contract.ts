import {afterEach,beforeEach,describe,expect,it} from "vitest";
import {emptyCheckpoint,ERROR,TASKS,type BaseCheckpointSaver,type Checkpoint,type CheckpointMetadata} from "@langchain/langgraph-checkpoint";
import {HumanMessage} from "@langchain/core/messages";
import type {RunnableConfig} from "@langchain/core/runnables";
export interface CheckpointFixture{saver:BaseCheckpointSaver;threadId:string;dispose():Promise<void>}
const checkpoint=(id:string,values:Record<string,unknown>={}):Checkpoint=>({...emptyCheckpoint(),id,channel_values:values,channel_versions:Object.fromEntries(Object.keys(values).map(key=>[key,Number(id)+1]))});
const metadata=(step=0):CheckpointMetadata=>({source:'loop',step,parents:{}});
export function checkpointContract(name:string,create:()=>Promise<CheckpointFixture>){
  describe(`${name}: LangGraph checkpoint contract`,()=>{
    let f:CheckpointFixture;beforeEach(async()=>{f=await create();});afterEach(async()=>{await f?.dispose();});
    const save=(cfg:RunnableConfig,cp:Checkpoint,meta:CheckpointMetadata,_versions:Record<string,never>)=>f.saver.put(cfg,cp,meta,cp.channel_versions);
    const config=(id?:string,namespace=''):RunnableConfig=>({configurable:{thread_id:f.threadId,checkpoint_ns:namespace,...(id?{checkpoint_id:id}:{})}});
    it('round-trips typed graph state, metadata and parent pointers',async()=>{
      const parent=await save(config(),checkpoint('001',{messages:[new HumanMessage('日本語')],count:1}),metadata(0),{});
      await save(parent,checkpoint('002',{count:2}),metadata(1),{});
      const current=(await f.saver.getTuple(config()))!;
      expect(current.checkpoint.channel_values.count).toBe(2);
      expect(current.parentConfig?.configurable?.checkpoint_id).toBe('001');
      expect(current.metadata).toMatchObject({source:'loop',step:1});
      const previous=(await f.saver.getTuple(config('001')))!;
      const message=(previous.checkpoint.channel_values.messages as HumanMessage[])[0];
      expect(message).toBeInstanceOf(HumanMessage);expect(message.content).toBe('日本語');
    });
    it('isolates namespaces and pages history with before/filter/limit',async()=>{
      for(let i=0;i<24;i++)await save(config(),checkpoint(String(i).padStart(3,'0'),{value:i}),metadata(i),{});
      await save(config(undefined,'nested'),checkpoint('999',{value:'nested'}),metadata(99),{});
      const all=[];for await(const tuple of f.saver.list(config()))all.push(tuple.checkpoint.id);
      expect(all).toEqual(Array.from({length:24},(_,i)=>String(23-i).padStart(3,'0')));
      const page=[];for await(const tuple of f.saver.list(config(),{before:config('020'),limit:2}))page.push(tuple.checkpoint.id);
      expect(page).toEqual(['019','018']);
      const filtered=[];for await(const tuple of f.saver.list(config(),{filter:{step:2},limit:1}))filtered.push(tuple.checkpoint.id);
      expect(filtered).toEqual(['002']);
      expect((await f.saver.getTuple(config(undefined,'nested')))!.checkpoint.channel_values.value).toBe('nested');
    });
    it('keeps first normal writes, updates special writes and sorts by task path',async()=>{
      await save(config(),checkpoint('001'),metadata(),{});
      await f.saver.putWrites(config('001'),[['value','first']],'normal','a');
      await f.saver.putWrites(config('001'),[['value','duplicate']],'normal','a');
      await f.saver.putWrites(config('001'),[[ERROR,'old']],'error','z');
      await f.saver.putWrites(config('001'),[[ERROR,'new']],'error','z');
      await f.saver.putWrites(config('001'),[['value','astral']],'unicode-astral','😀');
      await f.saver.putWrites(config('001'),[['value','bmp']],'unicode-bmp','\ue000');
      const tuple=(await f.saver.getTuple(config('001')))!;
      expect(tuple.pendingWrites).toEqual([['normal','value','first'],['error',ERROR,'new'],['unicode-bmp','value','bmp'],['unicode-astral','value','astral']]);
    });
    it('walks only parent ancestors when replaying channel deltas',async()=>{
      await save(config(),checkpoint('001',{value:['seed']}),metadata(),{});
      await f.saver.putWrites(config('001'),[['value','ancestor']],'first');
      await save(config('001'),checkpoint('002'),metadata(),{});
      await f.saver.putWrites(config('002'),[['value','delta']],'second');
      await save(config('001'),checkpoint('003',{value:['unrelated branch']}),metadata(),{});
      await save(config('002'),checkpoint('004'),metadata(),{});
      expect(await f.saver.getDeltaChannelHistory({config:config('004'),channels:['value']})).toEqual({value:{seed:['seed'],writes:[['first','value','ancestor'],['second','value','delta']]}});
    });
    it('restores legacy pending sends without rewriting old checkpoints',async()=>{
      await save(config(),{...checkpoint('001'),v:3},metadata(),{});
      await f.saver.putWrites(config('001'),[[TASKS,{node:'tool',args:{value:1}}]],'send');
      await save(config('001'),{...checkpoint('002'),v:3},metadata(),{});
      expect((await f.saver.getTuple(config('002')))!.checkpoint.channel_values[TASKS]).toEqual([{node:'tool',args:{value:1}}]);
    });
    it('deletes checkpoints and intermediate writes for a thread',async()=>{
      await save(config(),checkpoint('001'),metadata(),{});
      await f.saver.putWrites(config('001'),[['value',1]],'task');
      await f.saver.deleteThread(f.threadId);
      expect(await f.saver.getTuple(config())).toBeUndefined();
    });
  });
}
