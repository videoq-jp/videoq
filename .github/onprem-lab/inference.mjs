// Deterministic protocol fixture, not a model. Never deploy outside the lab.
import { createServer } from 'node:http';
const counts = { transcription: 0, embeddings: 0, chat: 0 };
createServer(async (req, res) => {
  const chunks = []; for await (const chunk of req) chunks.push(chunk);
  const raw = Buffer.concat(chunks);
  const json = value => { res.writeHead(200, {'content-type':'application/json'}); res.end(JSON.stringify(value)); };
  if (req.url === '/counts') return json(counts);
  if (req.url === '/v1/audio/transcriptions') {
    counts.transcription++;
    if (!raw.includes(Buffer.from('filename=')) || raw.length < 500) { res.writeHead(400); return res.end(); }
    return json({task:'transcribe', language:'en', duration:2, text:'VideoQ runs on Kubernetes.', segments:[{id:0,start:0,end:2,text:'VideoQ runs on Kubernetes.'}]});
  }
  const body = raw.length ? JSON.parse(raw.toString()) : {};
  if (req.url === '/v1/embeddings') {
    counts.embeddings++;
    const input = Array.isArray(body.input) ? body.input : [body.input];
    return json({object:'list',model:body.model,data:input.map((_,index)=>({object:'embedding',index,embedding:[1,...Array(1535).fill(0)]})),usage:{prompt_tokens:8,total_tokens:8}});
  }
  if (req.url === '/v1/chat/completions') {
    counts.chat++;
    const searched = body.messages?.some(message => message.role === 'tool' && message.content?.includes('sourceId'));
    const id = 'chatcmpl-lab-' + counts.chat;
    const choice = searched
      ? {index:0,message:{role:'assistant',content:JSON.stringify({segments:[{text:'VideoQ runs on Kubernetes.',sourceIds:[1]}]})},finish_reason:'stop'}
      : {index:0,message:{role:'assistant',content:null,tool_calls:[{id:'call_lab_search',type:'function',function:{name:'search_scenes',arguments:JSON.stringify({query:'VideoQ Kubernetes',video_ids:null})}}]},finish_reason:'tool_calls'};
    if (body.stream) {
      res.writeHead(200, {'content-type':'text/event-stream'});
      const {message,finish_reason} = choice;
      const delta = message.tool_calls ? {role:'assistant',tool_calls:message.tool_calls.map((call,index)=>({index,...call}))} : {role:'assistant',content:message.content};
      for (const part of [{choices:[{index:0,delta,finish_reason:null}]},{choices:[{index:0,delta:{},finish_reason}],usage:{prompt_tokens:30,completion_tokens:15,total_tokens:45}}]) res.write('data: '+JSON.stringify({id,object:'chat.completion.chunk',created:1,model:body.model,...part})+'\n\n');
      return res.end('data: [DONE]\n\n');
    }
    return json({id,object:'chat.completion',created:1,model:body.model,choices:[choice],usage:{prompt_tokens:30,completion_tokens:15,total_tokens:45}});
  }
  res.writeHead(404); res.end();
}).listen(8080, '0.0.0.0');
