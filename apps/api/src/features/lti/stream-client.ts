/** Runs in the API frame: stream parsing and feedback credentials never move into Moodle. */
export const streamClientScript = String.raw`
const feedbackRefs=new Map();
function setScope(videos){if(bridge&&Array.isArray(videos)){bridge.videos=videos;announceReady();}}
function addFeedback(el,responseId){
 const ref=feedbackRefs.get(responseId);if(!ref)return;
 const row=document.createElement('div');row.className='feedback-controls';
 for(const value of ['good','bad']){const button=document.createElement('button');button.type='button';button.textContent=value==='good'?'Good':'Bad';button.setAttribute('aria-label',button.textContent);button.setAttribute('aria-pressed',String(ref.value===value));button.addEventListener('click',()=>rateAnswer(responseId,ref.value===value?null:value));row.append(button);}
 const error=document.createElement('small');error.className='feedback-error';error.setAttribute('role','status');row.append(error);el.append(row);ref.controls=row;
}
async function rateAnswer(responseId,value){
 const ref=feedbackRefs.get(responseId);if(!ref||ref.busy||!(value===null||value==='good'||value==='bad'))return;
 ref.busy=true;for(const button of ref.controls?.querySelectorAll('button')||[])button.disabled=true;
 try{
  const res=await fetch('/api/lti/feedback',{method:'POST',credentials:'omit',headers:{'Content-Type':'application/json','Authorization':'Bearer '+token},body:JSON.stringify({feedbackId:ref.id,feedback:value})});
  if(!res.ok)throw new Error(uiCopy.feedbackError);
  const data=await res.json();if(!(data.feedback===null||data.feedback==='good'||data.feedback==='bad'))throw new Error(uiCopy.feedbackError);
  ref.value=data.feedback;
  if(ref.controls){for(const button of ref.controls.querySelectorAll('button'))button.setAttribute('aria-pressed',String(button.textContent.toLowerCase()===ref.value));ref.controls.querySelector('.feedback-error').textContent='';}
  notifyChat('feedback',{targetRequestId:responseId,feedback:ref.value,ok:true});
 }catch{
  if(ref.controls)ref.controls.querySelector('.feedback-error').textContent=uiCopy.feedbackError;
  notifyChat('feedback',{targetRequestId:responseId,feedback:ref.value,ok:false,text:uiCopy.feedbackError});
 }finally{ref.busy=false;for(const button of ref.controls?.querySelectorAll('button')||[])button.disabled=false;}
}
async function readAnswer(res,responseId){
 if(!res.headers.get('Content-Type')?.includes('text/event-stream')){
  const data=await res.json();setScope(data.videos);
  if(typeof data.feedbackId==='string'&&/^[a-f0-9]{64}$/.test(data.feedbackId))feedbackRefs.set(responseId,{id:data.feedbackId,value:data.feedback??null,busy:false});
  return {answer:data.answer};
 }
 const reader=res.body?.getReader();if(!reader)throw new Error(uiCopy.interrupted);
 const decoder=new TextDecoder(),segments=new Map(),sources=new Map();let buffer='',done=false,scheduled=null,element=null,dirty=false;
 const current=()=>({segments:[...segments.entries()].sort((a,b)=>a[0]-b[0]).map(([,value])=>({text:value.text,sourceIds:[...value.sourceIds]})),sources:[...sources.values()]});
 const segment=index=>{if(!segments.has(index))segments.set(index,{text:'',sourceIds:[]});return segments.get(index);};
 function render(){scheduled=null;dirty=false;const answer=current();if(!answer.segments.some(part=>part.text))return;if(!nativeUi)element=showAnswer(answer,element);notifyChat('answer-update',{answer});scrollLatest();}
 function change(){if(nativeUi){dirty=true;return;}if(scheduled===null)scheduled=requestAnimationFrame(render);}
 function event(data){
  if(done)return;
  if(data.type==='scope'){setScope(data.videos);return;}
  if(data.type==='error')throw new Error(data.code==='AI_ANSWERS_LIMIT_EXCEEDED'?data.message:uiCopy.answerError);
  if(data.type==='source'&&data.source&&Number.isSafeInteger(data.source.id)){sources.set(data.source.id,data.source);change();}
  else if((data.type==='text_delta'||data.type==='citation')&&Number.isSafeInteger(data.segmentIndex)&&data.segmentIndex>=0&&data.segmentIndex<10000){
   const value=segment(data.segmentIndex);
   if(data.type==='text_delta'&&typeof data.text==='string')value.text+=data.text;
   else if(data.type==='citation'&&Number.isSafeInteger(data.sourceId)&&!value.sourceIds.includes(data.sourceId))value.sourceIds.push(data.sourceId);
   change();
  }else if(data.type==='done'){
   done=true;
   if(typeof data.feedbackId==='string'&&/^[a-f0-9]{64}$/.test(data.feedbackId))feedbackRefs.set(responseId,{id:data.feedbackId,value:data.feedback??null,busy:false});
  }
 }
 function frames(){let end;while((end=buffer.indexOf('\n\n'))!==-1){const block=buffer.slice(0,end);buffer=buffer.slice(end+2);const json=block.split('\n').filter(line=>line.startsWith('data:')).map(line=>line.slice(5).trimStart()).join('\n');if(json)event(JSON.parse(json));}}
 try{
  for(;;){const result=await reader.read();buffer+=decoder.decode(result.value,{stream:!result.done});buffer=buffer.replace(/\r\n/g,'\n');if(buffer.length>1000000)throw new Error(uiCopy.interrupted);frames();if(nativeUi&&dirty)render();if(result.done)break;}
  if(!done)throw new Error(uiCopy.interrupted);
  const answer=current();if(!answer.segments.some(part=>part.text.trim()))throw new Error(uiCopy.answerError);
  return {answer,element};
 }finally{if(scheduled!==null){cancelAnimationFrame(scheduled);render();}else if(dirty)render();reader.releaseLock();}
}
`;
