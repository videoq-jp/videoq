import { expect, it, vi, afterEach } from 'vitest';
import { resolveLlmConnection } from '../src/lib/openai';
import { embedQuery } from '../src/lib/embeddings';
import { WORKERS_CHAT_MODEL, WORKERS_EMBEDDING_MODEL, WORKERS_BINDING_BASE_URL } from '../src/lib/workers-ai';
import type { Bindings } from '../src/types/bindings';
const settings=(run:ReturnType<typeof vi.fn>)=>({AI_PROVIDER:'workers-ai',AI:{run},LLM_MODEL:WORKERS_CHAT_MODEL,EMBEDDING_PROFILE:'embeddinggemma2',EMBEDDING_MODEL:WORKERS_EMBEDDING_MODEL,OPENROUTER_API_KEY:'stale',OPENROUTER_FEDERATION_POLICY_ID:'stale',OPENAI_API_KEY:'stale'} as unknown as Bindings);
afterEach(()=>vi.unstubAllGlobals());
it('uses the AI binding for chat without public fetch, keys or federation exchange',async()=>{
 const native=Response.json({choices:[{message:{content:'ok'}}]});const run=vi.fn(async()=>native);const env=settings(run);
 vi.stubGlobal('fetch',vi.fn(()=>{throw Error('Unexpected external HTTP');}));
 const connection=resolveLlmConnection(env);expect(connection.baseURL).toBe(WORKERS_BINDING_BASE_URL);
 const response=await connection.fetch!(`${connection.baseURL}/chat/completions`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({model:WORKERS_CHAT_MODEL,messages:[{role:'user',content:'hello'}],stream:true,reasoning_effort:'none'})});
 expect(response).toBe(native);expect(run).toHaveBeenCalledWith(WORKERS_CHAT_MODEL,{messages:[{role:'user',content:'hello'}],stream:true,chat_template_kwargs:{enable_thinking:false}},expect.objectContaining({returnRawResponse:true}));
 expect(fetch).not.toHaveBeenCalled();
 await expect(connection.fetch!('https://attacker.invalid/chat/completions',{method:'POST'})).rejects.toThrow('destination');
});
it('rejects unapproved models and redacts provider failures',async()=>{
 const run=vi.fn(async()=>{throw Error('PRIVATE PROMPT KEY');});const connection=resolveLlmConnection(settings(run));
 const send=(model:string)=>connection.fetch!(`${connection.baseURL}/chat/completions`,{method:'POST',body:JSON.stringify({model,messages:[]})});
 await expect(send('other-model')).rejects.toThrow('model');expect(run).not.toHaveBeenCalled();
 const response=await send(WORKERS_CHAT_MODEL);expect(response.status).toBe(502);expect(await response.text()).not.toContain('PRIVATE');
});
it('embeds queries in the same 768d space using the required query instruction',async()=>{
 const vector=Array.from({length:768},(_,i)=>i===0?1:0);const run=vi.fn(async()=>({data:[{index:0,embedding:vector}],usage:{prompt_tokens:5,total_tokens:5}}));
 expect(await embedQuery(settings(run),'アフィン変換')).toEqual(vector);
 expect(run).toHaveBeenCalledWith(WORKERS_EMBEDDING_MODEL,{input:['task: search result | query: アフィン変換'],dimensions:768,encoding_format:'float'},expect.anything());
});
it('fails closed with absent bindings, incompatible embedding output and stale credentials',async()=>{
 const run=vi.fn(async()=>({data:[{index:0,embedding:[1,2]}]}));const env=settings(run);
 await expect(embedQuery(env,'query')).rejects.toThrow('incompatible');
 delete env.AI;await expect(embedQuery(env,'query')).rejects.toThrow('binding');expect(()=>resolveLlmConnection(env)).toThrow('binding');
});

it('normalizes the native terminal usage event without buffering the answer',async()=>{
 const events=[{choices:[{index:0,delta:{content:'hello'},finish_reason:null}]},{choices:[{index:0,delta:{},finish_reason:'stop'}]},{response:'',usage:{prompt_tokens:3,completion_tokens:1,total_tokens:4}}];
 const data=events.map(value=>`data: ${JSON.stringify(value)}\n\n`).join('')+'data: [DONE]\n\n';
 const run=vi.fn(async()=>new Response(data,{headers:{'Content-Type':'text/event-stream'}}));
 const connection=resolveLlmConnection(settings(run));
 const response=await connection.fetch!(`${connection.baseURL}/chat/completions`,{method:'POST',body:JSON.stringify({model:WORKERS_CHAT_MODEL,messages:[],stream:true})});
 const chunks=(await response.text()).split('\n\n').filter(Boolean);
 expect(chunks[0]).toContain('hello');expect(chunks[1]).toContain('stop');
 expect(JSON.parse(chunks[2].slice(6))).toEqual({choices:[],usage:{prompt_tokens:3,completion_tokens:1,total_tokens:4}});
 expect(chunks[3]).toBe('data: [DONE]');
});
it('supplies required JSON keys to Gemma as an instruction as well as a constraint',async()=>{
 const {generateReply}=await import('../src/lib/llm');
 const answer={segments:[{text:'動作確認',sourceIds:[]}]};
 const run=vi.fn(async(_model:string,_parameters:unknown)=>Response.json({id:'reply',object:'chat.completion',created:1,model:WORKERS_CHAT_MODEL,choices:[{index:0,message:{role:'assistant',content:JSON.stringify(answer)},finish_reason:'stop'}]}));
 const env={...settings(run),LLM_SEPARATE_TOOL_SCHEMA:'true'} as Bindings;
 expect(await generateReply(env,'日本語で回答。','確認')).toEqual(answer);
 const parameters=run.mock.calls[0]?.[1] as {messages:Array<{role:string;content:string}>};
 expect(parameters.messages[0].content).toContain('Include every required property');
 expect(parameters.messages[0].content).toContain('sourceIds');
 expect(parameters.messages.filter(message=>message.content.includes('Return only JSON matching this schema.'))).toHaveLength(1);
});
