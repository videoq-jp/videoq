import {timingSafeEqual} from 'node:crypto';
import {edgeBenchmarkInput} from './edge-benchmark';
/** Private service binding only, with an additional short-lived random capability.
 * Authenticate before consuming the body or opening any database connection. */
export async function handleEdgeBenchmark(
 request:Request,secret:string|undefined,measure:(input:unknown)=>Promise<unknown>,
){
 const reply=(status:number,body:unknown)=>Response.json(body,{status,headers:{'cache-control':'no-store'}});
 if(!secret||!/^[a-f0-9]{64}$/.test(secret))return reply(503,{error:'unavailable'});
 const supplied=Buffer.from(request.headers.get('authorization')??''),expected=Buffer.from('Bearer '+secret);
 if(supplied.length!==expected.length||!timingSafeEqual(supplied,expected))return reply(401,{error:'unauthorized'});
 if(request.method!=='POST'||new URL(request.url).pathname!=='/measure')return reply(404,{error:'not_found'});
 if(request.headers.get('content-type')?.split(';')[0].trim()!=='application/json')return reply(400,{error:'invalid_input'});
 const reader=request.body?.getReader();if(!reader)return reply(400,{error:'invalid_input'});
 let input:unknown;
 try{
  const chunks:Uint8Array[]=[];let size=0;
  for(;;){const part=await reader.read();if(part.done)break;const chunk:unknown=part.value;if(!(chunk instanceof Uint8Array))throw new Error('Invalid input');size+=chunk.byteLength;if(size>16384){await reader.cancel();return reply(413,{error:'input_too_large'});}chunks.push(chunk);}
  input=JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
 }catch{return reply(400,{error:'invalid_input'});}
 finally{reader.releaseLock();}
 const parsed=edgeBenchmarkInput.safeParse(input);if(!parsed.success)return reply(400,{error:'invalid_input'});
 try{return reply(200,await measure(parsed.data));}
 catch{return reply(502,{error:'measurement_failed'});}
}
