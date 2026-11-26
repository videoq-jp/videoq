/** Isolated webhook receiver; deploy separately to exercise real outbound delivery. */
import {timingSafeEqual} from 'node:crypto';
type Env={DB:D1Database;ACCEPTANCE_SINK_TOKEN:string};
export default {async fetch(request:Request,env:Env) {
 const actual=new TextEncoder().encode(request.headers.get('authorization')??''),expected=new TextEncoder().encode('Bearer '+env.ACCEPTANCE_SINK_TOKEN);
 if(request.method!=='POST'||!env.ACCEPTANCE_SINK_TOKEN||actual.length!==expected.length||!timingSafeEqual(actual,expected)) return new Response(null,{status:403});
 const key=request.headers.get('Idempotency-Key');if(!key||!/^[a-f0-9]{64}$/.test(key)) return new Response(null,{status:400});
 const body=await request.json<{subject:string;owner:string;event:string;severity:string}>();
 if(body.subject!==key||body.owner!=='yukiharada1228'||!['warning','incident'].includes(body.severity)) return new Response(null,{status:400});
 await env.DB.prepare('INSERT INTO acceptance_notifications(id,event,severity) VALUES(?,?,?) ON CONFLICT DO NOTHING').bind(key,body.event,body.severity).run();
 return new Response(null,{status:204});
}};
