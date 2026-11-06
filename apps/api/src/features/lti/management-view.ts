import type { LtiLocale } from './locale';

const copies = {
  en: {
    title: 'Manage course materials', notice: 'Edit the AI description and SRT transcript here. Change the source title, file, visibility and deletion in Moodle.',
    lesson: 'Material to manage', description: 'AI description', transcript: 'Transcript (SRT)', save: 'Save changes', refresh: 'Refresh materials',
    reindex: 'Rebuild search index', retry: 'Retry processing', close: 'Return to questions', loading: 'Loading…', saved: 'Changes saved.',
    queued: 'Processing queued. AI search uses this material again after indexing finishes.',
    unavailable: 'Material management is unavailable. Check your current Moodle permissions or relaunch.',
    error: 'Unable to complete this operation. Your draft has been kept. Refresh or relaunch from Moodle.',
    conflict: 'The material changed or is busy. Your draft has been kept. Copy your changes before refreshing.',
    validation: 'Use valid SRT up to 2 MiB and a description up to 20,000 characters and 40 KB. Your draft has been kept.',
    discard: 'Discard the unsaved changes and load the current material?', discardAction: 'Discard changes',
    clear: 'Clear the transcript and remove this material from AI search? The Moodle source file is kept.',
    reindexConfirm: 'Rebuild the search index? This material is unavailable to AI search until processing finishes.',
    retryConfirm: 'Retry processing? Processing limits still apply.', confirm: 'Continue',
    pending: 'Processing is in progress. Editing becomes available when it finishes.',
    olderJob: 'For this processing failure, use Retry synchronization in Moodle.',
    unsaved: 'Unsaved changes', changed: 'The saved material has changed. Your draft is preserved.',
    status: 'Status', job: 'Processing', completed: 'Ready', indexing: 'Updating search index', errorState: 'Processing failed',
    pendingState: 'Queued', processing: 'Processing', uploading: 'Transferring', failed: 'Failed', queuedState: 'Queued', running: 'Running',
  },
  ja: {
    title: '教材を管理', notice: 'AI用の説明とSRT文字起こしを編集できます。元教材の名前・ファイル・公開状態・削除はMoodleで変更してください。',
    lesson: '管理する教材', description: 'AI用の説明', transcript: '文字起こし（SRT）', save: '変更を保存', refresh: '教材情報を更新',
    reindex: '検索索引を再作成', retry: '処理を再試行', close: '質問画面に戻る', loading: '読み込み中…', saved: '変更を保存しました。',
    queued: '処理を受け付けました。索引の更新が終わると、この教材をAI検索で再び利用できます。',
    unavailable: '教材管理を利用できません。現在のMoodle権限を確認するか、開き直してください。',
    error: '操作を完了できません。下書きは保持しています。更新するかMoodleから開き直してください。',
    conflict: '教材が変更されたか、処理中です。下書きは保持しています。必要な変更をコピーしてから更新してください。',
    validation: '文字起こしはSRT形式で2MiB以内、説明は2万文字かつ40KB以内にしてください。下書きは保持しています。',
    discard: '未保存の変更を破棄して、現在の教材情報を読み込みますか？', discardAction: '変更を破棄',
    clear: '文字起こしを消去し、この教材をAI検索から外しますか？Moodleの元ファイルは残ります。',
    reindexConfirm: '検索索引を再作成しますか？処理が終わるまで、この教材はAI検索の対象から外れます。',
    retryConfirm: '処理を再試行しますか？処理量の上限は引き続き適用されます。', confirm: '続ける',
    pending: '処理中です。処理が終わると編集できます。', olderJob: 'この処理エラーは、Moodleの「同期を再試行」からやり直してください。',
    unsaved: '未保存の変更があります', changed: '保存済みの教材が変更されました。下書きは保持しています。',
    status: '状態', job: '処理状況', completed: '準備完了', indexing: '検索索引を更新中', errorState: '処理エラー',
    pendingState: '処理待ち', processing: '処理中', uploading: '転送中', failed: '失敗', queuedState: '待機中', running: '実行中',
  },
} as const;

export function managementMarkup(locale: LtiLocale) {
  const copy = copies[locale];
  return `<details id="material-management" hidden><summary>${copy.title}</summary>
<p class="qa-hint">${copy.notice}</p><div class="qa-row"><button id="management-close" type="button" class="qa-button" hidden>${copy.close}</button>
<button id="management-refresh" type="button" class="qa-button">${copy.refresh}</button></div>
<label for="management-video">${copy.lesson}</label><select id="management-video"></select>
<p id="management-status" role="status" aria-live="polite"></p><p id="management-progress"></p>
<form id="management-form"><div class="qa-field"><label for="management-description">${copy.description}</label>
<textarea id="management-description" maxlength="20000" rows="4" readonly></textarea></div>
<div class="qa-field"><label for="management-transcript">${copy.transcript}</label>
<textarea id="management-transcript" maxlength="2097152" rows="12" spellcheck="false" readonly></textarea></div>
<div class="qa-row"><button id="management-save" type="submit" class="qa-button primary" disabled>${copy.save}</button>
<button id="management-reindex" type="button" class="qa-button" disabled>${copy.reindex}</button>
<button id="management-retry" type="button" class="qa-button" disabled>${copy.retry}</button></div></form></details>`;
}

export const managementStyles = `
#material-management{padding:12px 16px;flex-shrink:0;max-height:70dvh;overflow:auto;border-bottom:1px solid var(--border);overflow-wrap:anywhere}
#material-management summary{font-weight:600;cursor:pointer}#material-management textarea,#material-management select{box-sizing:border-box;max-width:100%;width:100%}
#management-transcript{font-family:ui-monospace,monospace}#management-status[data-error=true]{color:#b02a37}
.moodle-management .chat-header,.moodle-management #messages,.moodle-management .composer,.moodle-management #course-materials,.moodle-management #course-qa,.moodle-management #personal-history,.moodle-qa #material-management,.moodle-personal-history #material-management{display:none!important}
.moodle-management #material-management{display:block;flex:1;max-height:none;border:0}.moodle-management #material-management>summary{display:none}
.standalone-management #messages,.standalone-management .composer,.standalone-management #course-materials,.standalone-management #course-qa,.standalone-management #personal-history{display:none!important}
.standalone-management #material-management{flex:1;min-height:0;max-height:none}
`;

/** Runs in the existing private tool frame; no content or credentials cross postMessage. */
export function managementClientScript(locale: LtiLocale) {
  const copy = JSON.stringify(copies[locale]).replaceAll('<', '\\u003c');
  return `
const managementCopy=${copy},managementPanel=document.getElementById('material-management'),managementSelect=document.getElementById('management-video'),managementStatus=document.getElementById('management-status'),managementProgress=document.getElementById('management-progress'),managementDescription=document.getElementById('management-description'),managementTranscript=document.getElementById('management-transcript'),managementSave=document.getElementById('management-save'),managementRefresh=document.getElementById('management-refresh'),managementReindex=document.getElementById('management-reindex'),managementRetry=document.getElementById('management-retry'),managementClose=document.getElementById('management-close');
let managementAllowed=null,managementNativeOpen=false,managementBusy=false,managementDetail=null,managementObserved=null,managementVideos=[],managementError='',managementNotice='',managementDraftChanged=false,managementUncertain=null,managementPolls=0,managementTimer=null;
function managementDirty(){return !!managementDetail&&(managementDescription.value!==managementDetail.description||managementTranscript.value!==managementDetail.transcript);}
function managementAvailability(value){
 managementAllowed=value===true;
 if(!managementAllowed&&managementNativeOpen&&!managementDirty()){managementNativeOpen=false;document.body.classList.remove('moodle-management');}
 if(!managementAllowed&&!managementDirty()&&!nativeUi){managementPanel.open=false;document.body.classList.remove('standalone-management');document.querySelector('h1').textContent=uiCopy.heading;}
 managementPanel.hidden=nativeUi?!managementNativeOpen:(!features.management||(!managementAllowed&&!managementDirty()));
 if(nativeUi&&bridge)window.parent.postMessage({type:'videoq:management-availability',version:1,channel,videoId:bridge.videoId,available:managementAllowed,draft:managementDirty()},nativeUi.origin);
 managementDraw();
}
function managementCatalog(result){
 managementVideos=Array.isArray(result.managementVideos)?result.managementVideos:[];
 managementAvailability(features.management===true&&result.permissions?.manageContent===true&&managementVideos.length>0);
 const selected=Number(managementSelect.value)||managementDetail?.videoId||bridge?.videoId;
 managementSelect.replaceChildren();for(const video of managementVideos){const option=qaNode('option',video.title);option.value=String(video.videoId);managementSelect.append(option);}
 if(managementVideos.some(video=>video.videoId===selected))managementSelect.value=String(selected);
 if(managementDetail&&!managementVideos.some(video=>video.videoId===managementDetail.videoId)){
  if(managementDirty()){managementAllowed=false;managementError=managementCopy.unavailable;managementAvailability(false);}
  else{managementDetail=null;managementObserved=null;managementDescription.value='';managementTranscript.value='';managementDraw();}
 }
}
function managementDraw(){
 const detail=managementObserved||managementDetail,dirty=managementDirty(),locked=managementBusy||chatInFlight||managementAllowed!==true;
 managementPanel.setAttribute('aria-busy',String(managementBusy));managementStatus.dataset.error=String(!!managementError);
 managementStatus.textContent=managementBusy?managementCopy.loading:managementError||managementNotice||(managementDraftChanged?managementCopy.changed:dirty?managementCopy.unsaved:'');
 const labels={completed:managementCopy.completed,indexing:managementCopy.indexing,error:managementCopy.errorState,pending:managementCopy.pendingState,processing:managementCopy.processing,uploading:managementCopy.uploading,failed:managementCopy.failed,queued:managementCopy.queuedState,running:managementCopy.running};
 managementProgress.textContent=detail?managementCopy.status+': '+(labels[detail.status]||managementCopy.processing)+' · '+managementCopy.job+': '+(labels[detail.jobState]||managementCopy.processing)+(!detail.canEdit?' · '+managementCopy.pending:detail.status==='error'&&!detail.canRetry?' · '+managementCopy.olderJob:''):'';
 managementDescription.readOnly=managementTranscript.readOnly=locked||!detail?.canEdit;
 managementSave.disabled=locked||!detail?.canEdit||!dirty;
 managementReindex.disabled=locked||!detail?.canReindex||dirty;
 managementRetry.disabled=locked||!detail?.canRetry||dirty;
 managementSelect.disabled=managementBusy||chatInFlight||managementAllowed!==true;
 managementRefresh.disabled=managementBusy||chatInFlight;managementClose.hidden=!managementPanel.open;
}
function managementEnterNative(){document.body.classList.remove('standalone-management');managementPanel.hidden=!managementNativeOpen;if(managementAllowed!==null)managementAvailability(managementAllowed);}
function managementSetNativeOpen(open){managementNativeOpen=open===true&&(managementAllowed===true||managementDirty());document.body.classList.toggle('moodle-management',managementNativeOpen);managementPanel.hidden=!managementNativeOpen;managementPanel.open=managementNativeOpen;if(managementNativeOpen&&managementAllowed===true)void managementRun(()=>managementLoad(false));}
async function managementRequest(payload){
 const response=await fetch('/api/lti/management',{method:'POST',credentials:'omit',signal:AbortSignal.timeout(30000),headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body:JSON.stringify(payload)});
 if(!response.ok){if(response.status===401||response.status===403){managementError=managementCopy.unavailable;managementAvailability(false);}throw new Error(response.status===409?managementCopy.conflict:[400,413].includes(response.status)?managementCopy.validation:managementCopy.error);}
 return response.json();
}
async function managementRun(operation){if(managementBusy||chatInFlight)return;managementBusy=true;managementError='';managementNotice='';managementDraw();try{await operation();}catch(error){managementError=managementAllowed===false?managementCopy.unavailable:error.message||managementCopy.error;}finally{managementBusy=false;managementDraw();managementSchedule();}}
function managementApply(detail){
 managementObserved=detail;
 if(managementDirty()){if(detail.revision!==managementDetail.revision)managementDraftChanged=true;return;}
 managementDetail=detail;managementDraftChanged=false;managementDescription.value=detail.description;managementTranscript.value=detail.transcript;managementUncertain=null;
}
async function managementDiscard(){if(!managementDirty())return true;if(!await qaConfirm(managementCopy.discard,managementCopy.discardAction))return false;managementDetail=null;managementObserved=null;managementDescription.value='';managementTranscript.value='';managementDraftChanged=false;managementUncertain=null;return true;}
async function managementLoad(refreshCatalog=true){
 if(refreshCatalog)await materialRequest('list');
 if(managementAllowed!==true||!managementSelect.value)return;
 const id=Number(managementSelect.value);
 if(managementDetail&&managementDetail.videoId!==id){managementDetail=null;managementObserved=null;managementDescription.value='';managementTranscript.value='';}
 const result=await managementRequest({action:'get',videoId:id});managementApply(result.material);
}
async function managementMutation(action){
 if(!managementDetail||managementAllowed!==true||managementBusy||chatInFlight)return;
 const detail=managementDetail,fields={};
 if(action==='update'){
  if(managementDescription.value!==detail.description)fields.description=managementDescription.value;
  if(managementTranscript.value!==detail.transcript)fields.transcript=managementTranscript.value;
  if(!Object.keys(fields).length)return;
  if(Object.hasOwn(fields,'transcript')&&!fields.transcript.trim()&&!await qaConfirm(managementCopy.clear,managementCopy.confirm))return;
 }else if(!await qaConfirm(action==='reindex'?managementCopy.reindexConfirm:managementCopy.retryConfirm,managementCopy.confirm))return;
 const payload={action,videoId:detail.videoId,revision:detail.revision,...(action==='update'?{fields}:{})},signature=JSON.stringify(payload);
 // A response may be lost after commit. Reuse the operation identity while its
 // exact request is unchanged; never silently replace a local draft on error.
 if(managementUncertain?.signature!==signature)managementUncertain={signature,operationId:crypto.randomUUID()};
 const operationId=managementUncertain.operationId;
 await managementRun(async()=>{const result=await managementRequest({...payload,operationId});managementDetail=null;managementApply(result.material);managementPolls=0;managementNotice=result.material.status==='completed'?managementCopy.saved:managementCopy.queued;await materialRequest('list');});
}
function managementSchedule(){
 clearTimeout(managementTimer);const observed=managementObserved||managementDetail;if(!token||managementAllowed!==true||(!managementPanel.open&&learningEnabled)||!observed||observed.status==='completed'||observed.status==='error'||managementPolls>=60)return;
 managementTimer=setTimeout(()=>{if(document.hidden||managementBusy||chatInFlight){managementSchedule();return;}managementPolls++;void managementRun(()=>managementLoad(true));},5000);
}
async function managementInit(){if(features.management){managementPanel.hidden=!!nativeUi;await managementRun(()=>materialRequest('list'));}}
managementPanel.addEventListener('toggle',()=>{if(!nativeUi){document.body.classList.toggle('standalone-management',managementPanel.open);document.querySelector('h1').textContent=managementPanel.open?managementCopy.title:uiCopy.heading;if(managementPanel.open)void managementRun(()=>managementLoad());}managementDraw();managementSchedule();});
managementRefresh.addEventListener('click',async()=>{if(await managementDiscard()){managementPolls=0;await managementRun(()=>managementLoad());}});
managementSelect.addEventListener('change',async()=>{const id=Number(managementSelect.value);if(!await managementDiscard()){if(managementDetail)managementSelect.value=String(managementDetail.videoId);return;}managementSelect.value=String(id);managementPolls=0;await managementRun(()=>managementLoad(false));});
for(const field of [managementDescription,managementTranscript])field.addEventListener('input',()=>{managementError='';managementNotice='';managementDraw();});
document.getElementById('management-form').addEventListener('submit',event=>{event.preventDefault();void managementMutation('update');});
managementReindex.addEventListener('click',()=>void managementMutation('reindex'));managementRetry.addEventListener('click',()=>void managementMutation('retry'));
managementClose.addEventListener('click',()=>{managementPanel.open=false;if(nativeUi&&bridge){managementSetNativeOpen(false);window.parent.postMessage({type:'videoq:management-close',version:1,channel,videoId:bridge.videoId},nativeUi.origin);}});
window.addEventListener('beforeunload',event=>{if(managementDirty()){event.preventDefault();event.returnValue='';}});
window.addEventListener('pagehide',()=>clearTimeout(managementTimer),{once:true});
`;
}
