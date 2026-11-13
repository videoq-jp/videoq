import { classroomPageStyles, classroomMark } from './styles';
import { scriptJson } from '../lti/view';
import type { ClassroomLaunch } from './config';

export function page(nonce: string, title: string, markup: string, script: string) {
  return `<!doctype html><html lang="ja"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title><style nonce="${nonce}">${classroomPageStyles}</style><main class="material-page"><header class="material-header">${classroomMark}<div class="material-heading"><div class="material-context">Classroom 連携</div><h1>${title}</h1></div></header><section class="material-content">${markup}</section><footer class="material-footer">VideoQ による学習サポート</footer></main><script nonce="${nonce}">${script}</script></html>`;
}
/** Popup authentication keeps Google sign-in outside the Classroom iframe. No third-party cookies are needed in the iframe. */
export const popupScript = `
const origin=location.origin, openerWindow=window.opener;
let started=false;
if(!openerWindow){document.getElementById('status').textContent='Classroomの画面からログインしてください。';}
else{
 window.addEventListener('message',async event=>{
  if(event.origin!==origin||event.source!==openerWindow||event.data?.type!=='videoq:classroom-oauth-start'||started)return;started=true;
  try{const response=await fetch('/api/classroom/oauth/start',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(event.data.input)});
   if(!response.ok)throw new Error();const result=await response.json();location.replace(result.url);
  }catch{document.getElementById('status').textContent='Googleへの接続に失敗しました。元の画面からやり直してください。';}
 });
 openerWindow.postMessage({type:'videoq:classroom-oauth-ready'},origin);
}`;
export function authenticationScript(launch: ClassroomLaunch) {
  return `
const classroomLaunch=${scriptJson(launch)};
let classroomAccount=null;
const classroomDisconnect=document.createElement('button');classroomDisconnect.type='button';classroomDisconnect.textContent='Google アカウントの接続を解除';classroomDisconnect.hidden=true;const classroomAccountActions=document.getElementById('classroom-account-actions');if(classroomAccountActions)classroomAccountActions.append(classroomDisconnect);else document.getElementById('status').after(classroomDisconnect);
classroomDisconnect.addEventListener('click',async()=>{classroomDisconnect.disabled=true;try{await classroomRequest('disconnect',{});try{localStorage.removeItem(classroomStorageKey);}catch{}location.reload();}catch(error){classroomDisconnect.disabled=false;document.getElementById('status').textContent=error.message;}});
const classroomStorageKey='videoq-classroom-account';
async function classroomRequest(path,input,account=classroomAccount){
 const response=await fetch('/api/classroom/'+path,{method:'POST',credentials:'omit',signal:AbortSignal.timeout(30000),headers:{'Content-Type':'application/json',...(account?{Authorization:'Bearer '+account}:{})},body:JSON.stringify(input)});
 if(!response.ok){const error=new Error(response.status===401?'Googleに再ログインしてください。':'Classroomの権限または教材を確認できません。Classroomから開き直してください。');error.status=response.status;throw error;}
 return response.json();
}
async function classroomConnect(){
 const status=document.getElementById('status');
 let cached=null;try{cached=localStorage.getItem(classroomStorageKey);}catch{}
 const endpoint=classroomLaunch.view==='discovery'?'catalog':'session';
 if(cached&&classroomLaunch.login_hint){try{const result=await classroomRequest(endpoint,{launch:classroomLaunch},cached);classroomAccount=cached;classroomDisconnect.hidden=false;return result;}catch(error){if(![401,403].includes(error.status))throw error;}}
 status.textContent='Googleアカウントでログインしてください。';
 const button=document.createElement('button');button.type='button';button.textContent='Google でログイン';status.after(button);
 return new Promise((resolve,reject)=>{
  let popup=null,timeout=null;
  const cleanup=()=>{window.removeEventListener('message',receive);clearTimeout(timeout);button.remove();};
  const receive=async event=>{
   if(event.origin!==location.origin||event.source!==popup||!event.data)return;
   if(event.data.type==='videoq:classroom-oauth-ready'){popup.postMessage({type:'videoq:classroom-oauth-start',input:{loginHint:classroomLaunch.login_hint,teacher:classroomLaunch.view!=='student'}},location.origin);return;}
   if(event.data.type!=='videoq:classroom-oauth-result')return;
   cleanup();popup.close();
   if(typeof event.data.accountToken!=='string'){reject(new Error('Googleへのログインを完了できませんでした。画面を開き直してください。'));return;}
   try{classroomAccount=event.data.accountToken;const result=await classroomRequest(endpoint,{launch:classroomLaunch});try{localStorage.setItem(classroomStorageKey,classroomAccount);}catch{}classroomDisconnect.hidden=false;resolve(result);}catch(error){reject(error);}
  };
  window.addEventListener('message',receive);
  button.addEventListener('click',()=>{
   if(popup&&!popup.closed){popup.focus();return;}
   popup=window.open('/api/classroom/oauth/popup','videoq-classroom-auth','width=520,height=720');
   if(!popup){status.textContent='ポップアップを許可して、もう一度ログインしてください。';return;}
   clearTimeout(timeout);timeout=setTimeout(()=>{cleanup();reject(new Error('ログインの有効期限が切れました。画面を開き直してください。'));},300000);
  });
 });
}`;
}
export function discoveryScript(launch: ClassroomLaunch) {
  return `${authenticationScript(launch)}
(async()=>{try{
 const catalog=await classroomConnect(),select=document.getElementById('material'),attach=document.getElementById('attach'),status=document.getElementById('status');
 if(!catalog.connected){
  status.textContent='このクラスで使うVideoQアカウントと講座を接続してください。';
  const connect=document.createElement('button');connect.type='button';connect.textContent='自分のVideoQアカウントを接続';status.after(connect);
  connect.addEventListener('click',async()=>{const popup=window.open('about:blank','videoq-teacher-connect','width=640,height=800');
   if(!popup){status.textContent='ポップアップを許可してください。';return;}
   try{const result=await classroomRequest('teacher/connect',{launch:classroomLaunch});popup.location.replace(result.url);
    const refresh=document.createElement('button');refresh.type='button';refresh.textContent='接続を確認';connect.after(refresh);refresh.addEventListener('click',()=>location.reload());
   }catch(error){popup.close();status.textContent=error.message;}});
 }
 for(const material of catalog.materials){const option=document.createElement('option');option.value=material.id;option.textContent=material.title;select.append(option);}
 select.disabled=attach.disabled=!catalog.materials.length;if(catalog.connected)status.textContent=catalog.materials.length?'添付する教材を選択してください。':'利用できる教材がありません。';
 attach.addEventListener('click',async()=>{attach.disabled=true;try{await classroomRequest('attachments',{launch:classroomLaunch,materialId:select.value});status.textContent='教材を添付しました。';window.parent.postMessage({type:'Classroom',action:'closeIframe'},'https://classroom.google.com');}catch(error){status.textContent=error.message;attach.disabled=false;}});
}catch(error){document.getElementById('status').textContent=error.message;}})();`;
}
export const playerScript = `
const classroomVideo=document.getElementById('classroom-media'),classroomYoutube=document.getElementById('classroom-youtube'),classroomSelect=document.getElementById('classroom-video'),classroomPlayerStatus=document.getElementById('classroom-player-status');
let classroomSelected=null,classroomLoadSequence=0;
async function classroomLoad(videoId){
 const sequence=++classroomLoadSequence;
 classroomPlayerStatus.textContent='読み込み中…';
 try{
 const response=await fetch('/api/classroom/playback',{method:'POST',credentials:'omit',headers:{'Content-Type':'application/json',Authorization:'Bearer '+token},body:JSON.stringify({videoId})});
 if(sequence!==classroomLoadSequence)return false;
 if(!response.ok)throw new Error('動画を読み込めませんでした。');const data=await response.json();
 if(sequence!==classroomLoadSequence)return false;
 classroomSelected=videoId;classroomSelect.value=String(videoId);playback=null;classroomVideo.pause();classroomVideo.removeAttribute('src');classroomYoutube.removeAttribute('src');
 classroomVideo.hidden=data.kind!=='file';classroomYoutube.hidden=data.kind!=='youtube';
 if(data.kind==='file')classroomVideo.src=data.url;else classroomYoutube.src=data.url;
 classroomPlayerStatus.textContent='';if(typeof classroomVideoChanged==='function')classroomVideoChanged(data);return true;
 }catch(error){if(sequence!==classroomLoadSequence)return false;throw error;}
}
function classroomRenderVideos(videos){
 document.getElementById('classroom-player').hidden=!videos.length;
 const list=document.getElementById('classroom-video-list');list.replaceChildren();classroomSelect.replaceChildren();
 document.getElementById('classroom-video-count').textContent=videos.length+' '+(typeof classroomLayoutCopy==='object'?classroomLayoutCopy.count:'videos');
 for(const [index,video] of videos.entries()){
  const option=document.createElement('option');option.value=video.videoId;option.textContent=video.title;classroomSelect.append(option);
  const item=document.createElement('li'),button=document.createElement('button'),number=document.createElement('span'),title=document.createElement('span');
  button.type='button';button.dataset.classroomVideo=String(video.videoId);button.setAttribute('aria-pressed',String(video.videoId===classroomSelected));number.className='classroom-video-number';number.textContent=String(index+1);title.textContent=video.title;button.append(number,title);
  button.addEventListener('click',()=>{classroomSelect.value=String(video.videoId);void classroomLoad(video.videoId).catch(error=>{classroomPlayerStatus.textContent=error.message;});});item.append(button);list.append(item);
 }
 if(classroomSelected&&videos.some(video=>video.videoId===classroomSelected))classroomSelect.value=String(classroomSelected);
 else if(classroomSelected){classroomLoadSequence++;classroomSelected=null;playback=null;classroomVideo.pause();classroomVideo.removeAttribute('src');classroomYoutube.removeAttribute('src');}
}
async function classroomPlayerInit(videos){
 classroomRenderVideos(videos);
 document.getElementById('classroom-videos-refresh').addEventListener('click',async()=>{try{await materialRequest('list');}catch(error){classroomPlayerStatus.textContent=error.message;}});
 classroomSelect.addEventListener('change',()=>void classroomLoad(Number(classroomSelect.value)).catch(error=>{classroomPlayerStatus.textContent=error.message;}));
 if(videos.length)try{await classroomLoad(videos[0].videoId);}catch(error){classroomPlayerStatus.textContent=error.message;}
}
async function classroomSeek(source){const seconds=sourceSeconds(source.start_time);if(seconds===null)return;
 try{if(typeof classroomRevealPlayer==='function')classroomRevealPlayer();if(classroomSelected!==source.video_id){classroomSelect.value=String(source.video_id);if(!await classroomLoad(source.video_id))return;}
  const sequence=classroomLoadSequence;
  if(!classroomVideo.hidden){
   if(classroomVideo.readyState<1)await new Promise((resolve,reject)=>{
    const cleanup=()=>{clearTimeout(timeout);classroomVideo.removeEventListener('loadedmetadata',ready);classroomVideo.removeEventListener('error',failed);};
    const ready=()=>{cleanup();resolve();},failed=()=>{cleanup();reject(new Error('動画を読み込めませんでした。'));};
    const timeout=setTimeout(failed,15000);classroomVideo.addEventListener('loadedmetadata',ready,{once:true});classroomVideo.addEventListener('error',failed,{once:true});
   });
   if(sequence!==classroomLoadSequence||classroomSelected!==source.video_id)return;
   classroomVideo.currentTime=seconds;await classroomVideo.play();
  }
  else{const url=new URL(classroomYoutube.src);url.searchParams.set('start',String(Math.floor(seconds)));classroomYoutube.src=url.href;}
 }catch(error){classroomPlayerStatus.textContent=error.message;}
}
classroomVideo.addEventListener('timeupdate',()=>{if(classroomSelected&&!classroomVideo.hidden&&Number.isFinite(classroomVideo.duration))playback={videoId:classroomSelected,seconds:classroomVideo.currentTime,duration:classroomVideo.duration,receivedAt:performance.now()};});
`;
