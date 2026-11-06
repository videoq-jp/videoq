import { ltiCopy, type LtiLocale } from "./locale";
import { materialsMarkup, materialsClientScript } from "./materials-view";
import { qaMarkup, qaClientScript, qaStyles } from "./qa-view";
import { streamClientScript } from "./stream-client";
import { questionStyles } from "./view-styles";

/** Rendered on the API origin so embedding never needs third-party cookies. */
export function scriptJson(value: unknown): string {
  return JSON.stringify(value).replace(/</g, "\\u003c").replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");
}
export function loginView(nonce: string, state: string, secret: string, url: string, locale: LtiLocale = "ja"): string {
  const copy = ltiCopy[locale];
  return `<!doctype html><html lang="${locale}"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${copy.connectTitle}</title><p id="status">${copy.connecting}</p><script nonce="${nonce}">
try { sessionStorage.setItem('videoq-lti:'+${scriptJson(state)}, ${scriptJson(secret)}); location.replace(${scriptJson(url)}); }
catch { document.getElementById('status').textContent=${scriptJson(copy.storageError)}; }
</script></html>`;
}
export function questionView(nonce: string, state: string, idToken: string, locale: LtiLocale = "ja", parentOrigins: string[] = []): string {
  const copy = ltiCopy[locale];
  return `<!doctype html><html lang="${locale}"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${copy.title}</title>
<style nonce="${nonce}">${questionStyles}${qaStyles}</style>
<main aria-label="${copy.chat}">
<header class="chat-header"><div class="chat-heading"><h1>${copy.heading}</h1><span class="brand">VideoQ</span></div>
</header>
${materialsMarkup(locale)}
${qaMarkup(locale)}
<section id="messages" aria-label="${copy.conversation}" aria-live="polite" aria-relevant="additions">
<div id="empty" class="empty"><div class="empty-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 11.5a8.4 8.4 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.4 8.4 0 0 1-3.8-.9L3 21l1.9-5.7A8.4 8.4 0 0 1 4 11.5a8.5 8.5 0 0 1 4.7-7.6 8.4 8.4 0 0 1 3.8-.9h.5a8.5 8.5 0 0 1 8 8v.5z"/></svg></div><h2>${copy.emptyTitle}</h2><p>${copy.emptyBody}</p></div></section>
<div class="composer"><p id="status" role="status">${copy.checking}</p><form id="form"><label class="sr-only" for="question">${copy.label}</label><div class="input-shell"><textarea id="question" rows="1" maxlength="4000" placeholder="${copy.placeholder}" required disabled></textarea><button id="send" type="submit" aria-label="${copy.send}" title="${copy.send}" disabled><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m22 2-7 20-4-9-9-4 20-7Z"/><path d="M22 2 11 13"/></svg></button></div><p class="composer-hint">${copy.hint}</p></form></div></main>
<script nonce="${nonce}">
(async()=>{
const state=${scriptJson(state)}, idToken=${scriptJson(idToken)},uiCopy=${scriptJson(copy)};
const status=document.getElementById('status'), question=document.getElementById('question'), send=document.getElementById('send');
let token, messages=[], history=[], bridge=null, playback=null, parentOrigin=null, nativeUi=null, nativeRequestId=null,features={},readyDeadline=0;
const seenQuestions=new Set();
function notifyChat(event,payload={}){if(nativeUi&&bridge)window.parent.postMessage({type:'videoq:chat',version:1,channel,videoId:bridge.videoId,event,requestId:nativeRequestId,...payload},nativeUi.origin);}
function nativeStatus(){notifyChat('status',{busy:send.disabled,text:status.textContent,kind:status.dataset.kind||''});}
const channel=Array.from(crypto.getRandomValues(new Uint8Array(16)),b=>b.toString(16).padStart(2,'0')).join('');
const timeLabel=seconds=>[Math.floor(seconds/3600),Math.floor(seconds/60)%60,Math.floor(seconds)%60].map(n=>String(n).padStart(2,'0')).join(':');
function sourceSeconds(value){
 if(typeof value!=='string'||!/^\\d{2,3}:\\d{2}:\\d{2}(?:[.,]\\d+)?$/.test(value))return null;
 const parts=value.replace(',','.').split(':').map(Number);if(parts[1]>=60||parts[2]>=60)return null;
 const seconds=parts[0]*3600+parts[1]*60+parts[2];return Number.isFinite(seconds)&&seconds<=604800?seconds:null;
}
const freshPlayback=()=>playback&&performance.now()-playback.receivedAt<5000?playback:null;
function validPlayback(value){return value&&[bridge.videoId,...(bridge.videos||[]).map(video=>video.videoId)].includes(value.videoId)&&typeof value.seconds==='number'&&Number.isFinite(value.seconds)&&typeof value.duration==='number'&&Number.isFinite(value.duration)&&value.duration>0&&value.duration<=604800&&value.seconds>=0&&value.seconds<=value.duration;}
function announceReady(){if(bridge&&window.parent!==window)for(const origin of bridge.parentOrigins)window.parent.postMessage({type:'videoq:ready',version:1,channel,videoId:bridge.videoId,features,...(bridge.videos?{videos:bridge.videos}:{})},origin);}
window.addEventListener('message',event=>{
 const data=event.data;
 // A late Moodle component can discover the channel after the player connects.
 // Only the approved parent may request this same public ready announcement.
 if(bridge&&event.source===window.parent&&bridge.parentOrigins.includes(event.origin)&&data?.version===1&&data.type==='videoq:hello'){announceReady();return;}
 if(!bridge||event.source!==window.parent||!bridge.parentOrigins.includes(event.origin)||!data||data.version!==1||data.channel!==channel||!([bridge.videoId,...(bridge.videos||[]).map(video=>video.videoId)].includes(data.videoId)))return;
 if(data.type==='videoq:ui'&&data.renderer==='moodle'){
  nativeUi={origin:event.origin};parentOrigin=event.origin;
  materialsPanel.hidden=true;
  qaEnterNative();
  notifyChat('history',{turns:history.map(({feedbackId,...turn})=>({...turn,feedbackAvailable:!!feedbackId}))});nativeStatus();return;
 }
 if(data.type==='videoq:materials'){void materialCommand(data,event.origin);return;}
 if(data.type==='videoq:qa-ui'&&features.qa&&nativeUi?.origin===event.origin&&typeof data.open==='boolean'){qaSetNativeOpen(data.open);return;}
 if(data.type==='videoq:question'){
  if(!nativeUi||nativeUi.origin!==event.origin||send.disabled||typeof data.text!=='string'||!data.text.trim()||data.text.length>4000||typeof data.requestId!=='string'||!/^[a-f0-9]{32}$/.test(data.requestId)||seenQuestions.has(data.requestId))return;
  if(Object.hasOwn(data,'playback')){if(data.playback===null)playback=null;else if(validPlayback(data.playback))playback={...data.playback,receivedAt:performance.now()};else return;}
  if(seenQuestions.size>=100)seenQuestions.delete(seenQuestions.values().next().value);
  seenQuestions.add(data.requestId);nativeRequestId=data.requestId;question.value=data.text;document.getElementById('form').requestSubmit();return;
 }
 if(data.type==='videoq:feedback'&&nativeUi&&nativeUi.origin===event.origin){if(typeof data.targetRequestId==='string')void rateAnswer(data.targetRequestId,data.feedback);return;}
 if(data.type==='videoq:open-source'&&nativeUi&&nativeUi.origin===event.origin){
  if(data.source&&Number.isSafeInteger(data.source.video_id))seekSource(data.source);return;
 }
 if(data.type==='videoq:theme'&&data.theme&&typeof data.theme==='object'){
  for(const key of ['primary','on-primary','text','surface','border','muted']){const value=data.theme[key];if(typeof value==='string'&&value.length<80&&/^(?:#[0-9a-f]{3,8}|rgba?\\([0-9.,%\\s]+\\)|hsla?\\([0-9.,%\\s]+\\))$/i.test(value)&&CSS.supports('color',value))document.documentElement.style.setProperty('--'+key,value);}
  if(typeof data.theme.font==='string'&&data.theme.font.length<200&&!/[;{}]/.test(data.theme.font))document.documentElement.style.setProperty('--moodle-font',data.theme.font);
  return;
 }
 if(data.type!=='videoq:state')return;
 if(typeof data.seconds!=='number'||!Number.isFinite(data.seconds)||typeof data.duration!=='number'||!Number.isFinite(data.duration)||data.duration<=0||data.duration>604800||data.seconds<0||data.seconds>data.duration)return;
 parentOrigin=event.origin;playback={videoId:data.videoId,seconds:data.seconds,duration:data.duration,receivedAt:performance.now()};
});
const timer=setInterval(()=>{if(bridge&&(!freshPlayback()||(!nativeUi&&performance.now()<readyDeadline)))announceReady();},1000);
window.addEventListener('pagehide',()=>clearInterval(timer),{once:true});
const messagesView=document.getElementById('messages');
function scrollLatest(){requestAnimationFrame(()=>{messagesView.scrollTop=messagesView.scrollHeight;});}
const conversationResize=new ResizeObserver(scrollLatest);conversationResize.observe(messagesView);
window.addEventListener('pagehide',()=>conversationResize.disconnect(),{once:true});
function resizeInput(){question.style.height='auto';question.style.height=Math.min(128,Math.max(44,question.scrollHeight))+'px';}
question.addEventListener('input',resizeInput);
question.addEventListener('keydown',event=>{if(event.key==='Enter'&&!event.shiftKey&&!event.isComposing&&event.keyCode!==229){event.preventDefault();if(!send.disabled&&question.value.trim())document.getElementById('form').requestSubmit();}});
// Build rich text from DOM nodes; model HTML is always literal text.
function inlineText(parent,text){
 for(const part of text.split(/(\\*\\*[^*\\n]+\\*\\*|\x60[^\x60\\n]+\x60)/g)){
  if(part.startsWith('**')&&part.endsWith('**')&&part.length>4){const strong=document.createElement('strong');strong.textContent=part.slice(2,-2);parent.append(strong);}
  else if(part.charCodeAt(0)===96&&part.charCodeAt(part.length-1)===96&&part.length>2){const code=document.createElement('code');code.textContent=part.slice(1,-1);parent.append(code);}
  else parent.append(document.createTextNode(part));
 }
}
function answerText(parent,text){
 for(const block of text.split(/\\n{2,}/)){
  const lines=block.split('\\n');
  if(lines.every(line=>/^\\s*[-*]\\s+/.test(line))){const list=document.createElement('ul');for(const line of lines){const item=document.createElement('li');inlineText(item,line.replace(/^\\s*[-*]\\s+/,''));list.append(item);}parent.append(list);}
  else if(/^#{1,3} /.test(block)&&lines.length===1){const heading=document.createElement('h3');inlineText(heading,block.replace(/^#{1,3} /,''));parent.append(heading);}
  else{const paragraph=document.createElement('p');inlineText(paragraph,block);parent.append(paragraph);}
 }
}
function show(text,kind){document.getElementById('empty').hidden=true;const el=document.createElement('article');el.className='message '+kind;const speaker=document.createElement('span');speaker.className='speaker';speaker.textContent=kind==='question'?${scriptJson(copy.you)}:${scriptJson(copy.assistant)};const body=document.createElement('div');body.className='message-body';if(kind==='answer')answerText(body,text);else body.textContent=text;el.append(speaker,body);messagesView.append(el);if(kind==='question')notifyChat('question',{text});scrollLatest();return el;}

function seekSource(source){
 const seconds=sourceSeconds(source.start_time),target=bridge?.videos?.find(video=>video.videoId===source.video_id);
 if(!bridge||!parentOrigin||seconds===null||!(source.video_id===bridge.videoId||target))return;
 window.parent.postMessage({type:'videoq:seek',version:1,channel,videoId:source.video_id,seconds,...(target?{lesson:target.lesson}:{})},parentOrigin);
}
function citation(source){
    const seconds=sourceSeconds(source.start_time),label=source.title+(source.start_time?' '+source.start_time:'');
    const target=bridge?.videos?.find(video=>video.videoId===source.video_id);
    if(bridge&&parentOrigin&&(source.video_id===bridge.videoId||target)&&seconds!==null){
     const button=document.createElement('button');button.type='button';button.className='citation';button.textContent='('+timeLabel(seconds).replace(/^00:/,'').replace(/^0(\\d:)/,'$1')+')';button.title=label;button.setAttribute('aria-label',label+${scriptJson(copy.seek)});
     button.addEventListener('click',()=>{if(!parentOrigin){status.textContent=${scriptJson(copy.playbackError)};return;}seekSource(source);});return button;
    }else{const reference=document.createElement('span');reference.className='source-text';reference.textContent=seconds!==null?'('+timeLabel(seconds).replace(/^00:/,'').replace(/^0(\\d:)/,'$1')+')':source.title;reference.title=label;return reference;}
}
function showAnswer(answer,existing=null){
 const prefix='videoq-ref-'+crypto.randomUUID()+':',references=[];
 const sourceMap=new Map(answer.sources.map(source=>[source.id,source]));
 const text=answer.segments.map(segment=>segment.text+[...new Set(segment.sourceIds)].map(id=>{
  const source=sourceMap.get(id);if(!source)return '';
  references.push(source);return prefix+(references.length-1)+';';
 }).join('')).join('');
 const el=existing||show('','answer'),body=el.querySelector('.message-body');body.replaceChildren();answerText(body,text);
 const walker=document.createTreeWalker(body,NodeFilter.SHOW_TEXT),nodes=[];
 while(walker.nextNode())nodes.push(walker.currentNode);
 for(const node of nodes){
  const parts=node.textContent.split(prefix);if(parts.length===1)continue;
  const fragment=document.createDocumentFragment();fragment.append(document.createTextNode(parts.shift()));
  for(const part of parts){const end=part.indexOf(';'),source=references[Number(part.slice(0,end))];if(end<0||!source){fragment.append(document.createTextNode(prefix+part));continue;}fragment.append(document.createTextNode(' '),citation(source),document.createTextNode(part.slice(end+1)));}
  node.replaceWith(fragment);
 }
 return el;
}

${streamClientScript}
${materialsClientScript}
${qaClientScript}
try {
 const key='videoq-lti:'+state, browserSecret=sessionStorage.getItem(key);
 if(!browserSecret) throw new Error(${scriptJson(copy.missing)});
 const res=await fetch('/api/lti/session',{method:'POST',credentials:'omit',headers:{'Content-Type':'application/json'},body:JSON.stringify({state,id_token:idToken,browserSecret})});
 if(!res.ok) throw new Error(${scriptJson(copy.connectionError)});
 const session=await res.json();token=session.token;features=session.features||{};sessionStorage.removeItem(key);
 materialsPanel.hidden=!features.transcripts;
 qaPanel.hidden=!features.qa;
 const historyResponse=await fetch('/api/lti/history',{method:'POST',credentials:'omit',headers:{'Authorization':'Bearer '+token}});
 if(!historyResponse.ok)throw new Error(${scriptJson(copy.connectionError)});
 const saved=await historyResponse.json();history=Array.isArray(saved.turns)?saved.turns:[];
 for(const turn of history){
  if(typeof turn.id!=='string'||typeof turn.question!=='string'||!turn.answer)continue;
  nativeRequestId=turn.id;show(turn.question,'question');const element=showAnswer(turn.answer);
  if(typeof turn.feedbackId==='string'){feedbackRefs.set(turn.id,{id:turn.feedbackId,value:turn.feedback});addFeedback(element,turn.id);}
 }
 messages=history.flatMap(turn=>[{role:'user',content:turn.question},{role:'assistant',content:turn.answer.segments.map(segment=>segment.text).join('')}]).slice(-8);
 nativeRequestId=null;
 if(session.playback&&window.parent!==window){bridge=session.playback;readyDeadline=performance.now()+30000;announceReady();}
 status.textContent=''; question.disabled=false;send.disabled=false;
}catch(error){status.dataset.kind='error';status.textContent=error.message;for(const origin of ${scriptJson(parentOrigins)})if(window.parent!==window)window.parent.postMessage({type:'videoq:unavailable',version:1,text:error.message},origin);return;}
document.getElementById('form').addEventListener('submit',async event=>{
 event.preventDefault();const text=question.value.trim();if(!text||send.disabled)return;
 const position=freshPlayback();if(!nativeUi)nativeRequestId=Array.from(crypto.getRandomValues(new Uint8Array(16)),b=>b.toString(16).padStart(2,'0')).join('');
 send.disabled=true;question.disabled=true;show(text,'question');
 status.dataset.kind='progress';status.textContent=${scriptJson(copy.answering)};send.classList.add('busy');messagesView.setAttribute('aria-busy','true');nativeStatus();
 const next=[...messages,{role:'user',content:text}];
 try{
  const res=await fetch('/api/lti/messages/stream',{method:'POST',credentials:'omit',headers:{'Content-Type':'application/json','Authorization':'Bearer '+token},body:JSON.stringify({messages:next,...(position?{playback:{video_id:position.videoId,position_seconds:position.seconds}}:{})})});
  if(!res.ok) throw new Error(res.status===401?${scriptJson(copy.expired)}:res.status===429?${scriptJson(copy.rateLimit)}:${scriptJson(copy.answerError)});
  const data=await readAnswer(res,nativeRequestId);const answer=data.answer.segments.map(segment=>segment.text).join('');const el=showAnswer(data.answer,data.element);addFeedback(el,nativeRequestId);notifyChat('answer',{answer:data.answer,feedbackAvailable:feedbackRefs.has(nativeRequestId),feedback:feedbackRefs.get(nativeRequestId)?.value??null});
  messages=[...next,{role:'assistant',content:answer}].slice(-8);question.value='';resizeInput();status.textContent='';scrollLatest();
 }catch(error){status.dataset.kind='error';status.textContent=error.message;}
 finally{send.disabled=false;send.classList.remove('busy');messagesView.setAttribute('aria-busy','false');question.disabled=false;if(!nativeUi)question.focus({preventScroll:true});nativeStatus();}
});
})();
</script></html>`;
}
