import {describe,it,expect} from 'vitest';
import {recoverVisualArtifacts,assertRecoveredVisuals} from '../../scripts/migrations/d1/recover-visual-artifacts';
function fixture(){
 const run='00000000-0000-4000-8000-000000000001',version='00000000-0000-4000-8000-000000000002',publication='00000000-0000-4000-8000-000000000003',file='synthetic/video.mp4',jpeg=Buffer.from([255,216,255,224,0,255,217]);
 const metadata=Buffer.from(JSON.stringify({version:1,video_id:1,duration_seconds:1,sampling_interval_seconds:1,frames:[[0,0,jpeg.length]]})),header=Buffer.alloc(12);header.write('VQFOC001');header.writeUInt32LE(metadata.length,8);const pack=Buffer.concat([header,metadata,jpeg]),offset=12+metadata.length;
 const samples=[{timestamp_seconds:0,jpeg_base64:jpeg.toString('base64'),offset,length:jpeg.length}],overview=[[0,0,offset,jpeg.length]],prefix=file+'.visual-v2/'+run+'/';
 const rows={videos:[{id:1,user_id:'synthetic-owner',file,source_type:'uploaded'}],video_visual_runs:[{video_id:1,run_id:run,file_key:file,duration_ms:1000,chunk_count:1,status:'ready',publication_version:publication}],video_visual_chunks:[{run_id:run,chunk_index:0,frame_count:1,object_version:version}]};
 const objects=new Map<string,Uint8Array>([[prefix+'0/'+version+'.bin',pack],[prefix+'0/'+version+'.json',Buffer.from(JSON.stringify(samples))],[prefix+'publications/'+publication+'/manifest.json',Buffer.from(JSON.stringify({version:2,video_id:1,run_id:run,duration_seconds:1,chunk_seconds:60,chunk_count:1,chunk_versions:[version],overview}))],[prefix+'publications/'+publication+'/overview.json',Buffer.from(JSON.stringify({version:1,video_id:1,duration_seconds:1,sampling_interval_seconds:5,frames:samples.map(({timestamp_seconds,jpeg_base64})=>({timestamp_seconds,jpeg_base64}))}))]]);
 const target=new Map<string,Uint8Array>(),source={read:async(key:string)=>objects.get(key)??null},destination={read:async(key:string)=>target.get(key)??null,create:async(key:string,bytes:Uint8Array)=>{if(target.has(key))throw Error('overwrite');target.set(key,bytes);}};return {rows,objects,target,source,destination,file,prefix};
}
describe('versioned visual recovery',()=>{
 it('copies legacy paths, validates the publication and binds an unforgeable receipt to rows',async()=>{
  const f=fixture(),original=[...f.objects.keys()],r=await recoverVisualArtifacts(f.rows,f.source,f.destination,true);expect(r.objects).toBe(4);expect(()=>assertRecoveredVisuals(f.rows,r)).not.toThrow();expect(()=>assertRecoveredVisuals(f.rows,{...r})).toThrow();
  const manifest=JSON.parse(Buffer.from(f.target.get(f.file+'.focus-v2.json')!).toString()) as Record<string,unknown>;expect(manifest.chunk_versions).toBeUndefined();expect(f.target.has(f.prefix+'0.bin')).toBe(true);expect([...f.objects.keys()]).toEqual(original);
  expect((await recoverVisualArtifacts(f.rows,f.source,f.destination,true)).sha256).toBe(r.sha256);f.rows.videos[0].user_id='other';expect(()=>assertRecoveredVisuals(f.rows,r)).toThrow();
 });
 it.each(['missing','wrong-manifest','wrong-sparse','conflict','missing-version','wrong-owner','incomplete-grid'])('refuses %s input',async(kind)=>{
  const f=fixture();if(kind==='missing')f.objects.delete([...f.objects.keys()][0]);if(kind==='wrong-manifest')f.objects.set([...f.objects.keys()].find(k=>k.endsWith('/manifest.json'))!,Buffer.from('{}'));if(kind==='wrong-sparse')f.objects.set(f.prefix+'0/'+f.rows.video_visual_chunks[0].object_version+'.json',Buffer.from('[]'));if(kind==='conflict')f.target.set(f.prefix+'0.bin',Buffer.from('conflict'));if(kind==='missing-version')f.rows.video_visual_chunks[0].object_version='invalid';if(kind==='wrong-owner')f.rows.videos[0].file='other.mp4';if(kind==='incomplete-grid')f.rows.video_visual_chunks=[];
  await expect(recoverVisualArtifacts(f.rows,f.source,f.destination,true)).rejects.toThrow();if(kind!=='conflict')expect(f.target.has(f.file+'.focus-v2.json')).toBe(false);
 });
 it('requires an offline separate destination',async()=>{const f=fixture();await expect(recoverVisualArtifacts(f.rows,f.source,f.destination,false)).rejects.toThrow();await expect(recoverVisualArtifacts(f.rows,f.destination,f.destination,true)).rejects.toThrow();});
});
