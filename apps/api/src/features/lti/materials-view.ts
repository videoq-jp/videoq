import { ltiCopy, type LtiLocale } from "./locale";

export function materialsMarkup(locale: LtiLocale) {
  const copy = ltiCopy[locale];
  return `<details id="course-materials" hidden><summary>${copy.transcript}</summary>
<label for="material-video">${copy.material}</label><select id="material-video"></select>
<button id="material-refresh" type="button">${copy.refreshMaterials}</button>
<p id="material-status" role="status"></p><ol id="material-cues"></ol>
<button id="material-more" type="button" hidden>${copy.moreTranscript}</button></details>`;
}

// Runs inside the authenticated LTI frame. Credentials never cross the bridge.
export const materialsClientScript = `
const materialsPanel=document.getElementById('course-materials'),materialSelect=document.getElementById('material-video'),materialStatus=document.getElementById('material-status'),materialCues=document.getElementById('material-cues'),materialMore=document.getElementById('material-more'),materialRefresh=document.getElementById('material-refresh');
let materialCursor=null,materialLoading=false,materialListLoaded=false;
async function materialRequest(action,payload={}){
 const response=await fetch('/api/lti/'+(action==='list'?'materials':'transcript'),{method:'POST',credentials:'omit',signal:AbortSignal.timeout(10000),headers:{'Content-Type':'application/json','Authorization':'Bearer '+token},body:JSON.stringify(payload)});
 if(!response.ok){if(action==='list'&&[401,403].includes(response.status)){learningRefresh([]);qaAvailability(false);personalAvailability(false);managementAvailability(false);}throw new Error(uiCopy.materialError);}
 const result=await response.json();if(action==='list'&&result?.permissions){const videos=Array.isArray(result.videos)?result.videos:[];learningRefresh(videos);qaAvailability(result.permissions.viewQa===true&&videos.length>0);personalAvailability(result.permissions.manageOwnHistory===true&&videos.length>0);managementCatalog(result);}return result;
}
let materialCommandBusy=false;
async function materialCommand(data,origin){
 if(!nativeUi||nativeUi.origin!==origin||typeof data.requestId!=='string'||!/^[a-f0-9]{32}$/.test(data.requestId)||!['list','transcript'].includes(data.action))return;
 const reply=payload=>window.parent.postMessage({type:'videoq:materials-result',version:1,channel,videoId:bridge.videoId,requestId:data.requestId,action:data.action,...payload},origin);
 if(materialCommandBusy){reply({ok:false,text:uiCopy.materialError});return;}
 materialCommandBusy=true;
 try{const payload=await materialRequest(data.action,data.action==='list'?{}:{videoId:data.targetVideoId,cursor:data.cursor??0});reply({ok:true,payload});}
 catch{reply({ok:false,text:uiCopy.materialError});}finally{materialCommandBusy=false;}
}
function resetMaterial(){materialCues.replaceChildren();materialCursor=null;materialMore.hidden=true;materialStatus.textContent='';}
function materialBusy(value){materialLoading=value;materialSelect.disabled=value;materialMore.disabled=value;materialRefresh.disabled=value;materialsPanel.setAttribute('aria-busy',String(value));}
async function loadMaterialList(){
 if(materialLoading)return;materialBusy(true);resetMaterial();
 try{const result=await materialRequest('list');materialSelect.replaceChildren();
  if(!result.permissions?.viewTranscript){materialsPanel.hidden=true;return;}
  for(const video of result.videos){const option=document.createElement('option');option.value=video.videoId;option.textContent=video.title;materialSelect.append(option);}
  materialListLoaded=true;
 }catch{materialListLoaded=false;materialSelect.replaceChildren();materialStatus.textContent=uiCopy.materialError;}finally{materialBusy(false);}
}
async function loadMaterialTranscript(append=false){
 if(materialLoading||!materialSelect.value)return;if(!append)resetMaterial();materialBusy(true);
 try{const result=await materialRequest('transcript',{videoId:Number(materialSelect.value),cursor:append?materialCursor:0});
  for(const cue of result.cues){const row=document.createElement('li'),button=document.createElement('button'),text=document.createElement('span');button.type='button';button.textContent=cue.startTime;button.addEventListener('click',()=>seekSource({video_id:result.videoId,start_time:cue.startTime}));text.textContent=' '+cue.text;row.append(button,text);materialCues.append(row);}
  materialCursor=result.nextCursor;materialMore.hidden=materialCursor===null;materialStatus.textContent=materialCues.children.length?'':uiCopy.emptyTranscript;
 }catch{resetMaterial();materialListLoaded=false;materialStatus.textContent=uiCopy.materialError;}finally{materialBusy(false);}
}
materialsPanel.addEventListener('toggle',async()=>{if(!materialsPanel.open||nativeUi)return;if(!materialListLoaded)await loadMaterialList();if(materialSelect.value&&!materialCues.children.length)await loadMaterialTranscript();});
materialSelect.addEventListener('change',()=>void loadMaterialTranscript());
materialMore.addEventListener('click',()=>void loadMaterialTranscript(true));
materialRefresh.addEventListener('click',async()=>{await loadMaterialList();if(materialSelect.value)await loadMaterialTranscript();});
`;
