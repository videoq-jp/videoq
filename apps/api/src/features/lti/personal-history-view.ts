import type { LtiLocale } from './locale';

const copies = {
  en: { title: 'My AI conversations', notice: 'Personal AI conversations are separate from shared course Q&A. The connected VideoQ account owner can manage stored logs.',
    new: 'New conversation', list: 'Saved conversations', recent: 'Earlier recent questions', refresh: 'Refresh', previous: 'Previous', next: 'Next',
    open: 'Read', continue: 'Continue this conversation', older: 'Older messages', latest: 'Latest messages', export: 'Download conversation', delete: 'Delete conversation',
    confirm: 'Delete this conversation, its answer logs and model memory? This cannot be undone.', cancel: 'Cancel',
    empty: 'No saved conversations yet.', loading: 'Loading…', error: 'Unable to load saved conversations. Refresh or relaunch from Moodle.',
    busy: 'Wait for the current answer to finish.', unavailable: 'Saved personal conversations are unavailable.', question: 'You', answer: 'VideoQ', back: 'Back to saved conversations' },
  ja: { title: '自分のAI会話', notice: '自分のAI会話はコースQ&Aには公開されません。接続先VideoQのアカウント所有者は保存ログを管理できます。',
    new: '新しい会話', list: '保存済み会話', recent: '以前の直近の質問', refresh: '更新', previous: '前へ', next: '次へ',
    open: '読む', continue: 'この会話を続ける', older: '以前のメッセージ', latest: '最新のメッセージ', export: '会話をダウンロード', delete: '会話を削除',
    confirm: 'この会話と回答ログ、AIの内部履歴を削除しますか？元に戻せません。', cancel: 'キャンセル',
    empty: '保存済みの会話はありません。', loading: '読み込み中…', error: '保存済み会話を読み込めません。更新するかMoodleから開き直してください。',
    busy: '回答が終わってから操作してください。', unavailable: '保存済み会話を利用できません。', question: 'あなた', answer: 'VideoQ', back: '保存済み会話に戻る' },
} as const;

export function personalHistoryMarkup(locale: LtiLocale) {
  return `<details id="personal-history" hidden><summary>${copies[locale].title}</summary><p class="qa-hint">${copies[locale].notice}</p>
<p id="personal-history-status" role="status" aria-live="polite"></p><div id="personal-history-content"></div></details>`;
}
export const personalHistoryStyles = `
#personal-history{padding:12px 16px;flex-shrink:0;max-height:55dvh;overflow:auto;border-bottom:1px solid var(--border);overflow-wrap:anywhere}
#personal-history summary{font-weight:600;cursor:pointer}#personal-history-status[data-error=true]{color:#b02a37}.personal-turn{white-space:pre-wrap;overflow-wrap:anywhere}
.moodle-personal-history .chat-header,.moodle-personal-history #messages,.moodle-personal-history .composer,.moodle-personal-history #course-materials,.moodle-personal-history #course-qa,.moodle-qa #personal-history{display:none!important}
.moodle-personal-history #personal-history{display:block;flex:1;max-height:none;border:0}.moodle-personal-history #personal-history>summary{display:none}
`;

/** The same private UI is opened inside the existing tool frame in Moodle. */
export function personalHistoryClientScript(locale: LtiLocale) {
  const copy = JSON.stringify(copies[locale]).replaceAll('<', '\\u003c');
  return `
const personalCopy=${copy},personalPanel=document.getElementById('personal-history'),personalContent=document.getElementById('personal-history-content'),personalStatus=document.getElementById('personal-history-status');
let personalAllowed=null,personalNativeOpen=false,personalBusy=false,personalError='',personalItems=[],personalHasMore=false,personalPage=0,personalDetail=null,personalOlder=false,personalLegacy=false;
let activeConversationId=null,resumePersonalConversation=false,personalInitialized=false;
function personalAvailability(value){
 personalAllowed=value===true;
 if(!personalAllowed){personalDetail=null;personalItems=[];personalContent.replaceChildren();if(activeConversationId){activeConversationId=null;resumePersonalConversation=false;replaceChatHistory([]);}if(personalNativeOpen){personalNativeOpen=false;document.body.classList.remove('moodle-personal-history');}}
 personalPanel.hidden=nativeUi?!personalNativeOpen:(!features.conversations||personalAllowed===false);
 if(nativeUi&&bridge)window.parent.postMessage({type:'videoq:history-availability',version:1,channel,videoId:bridge.videoId,available:personalAllowed},nativeUi.origin);
}
function personalEnterNative(){personalPanel.hidden=!personalNativeOpen;if(personalAllowed!==null)personalAvailability(personalAllowed);}
function personalSetNativeOpen(open){personalNativeOpen=open===true&&personalAllowed!==false;document.body.classList.toggle('moodle-personal-history',personalNativeOpen);personalPanel.hidden=!personalNativeOpen;personalPanel.open=personalNativeOpen;if(personalNativeOpen)void personalRun(personalList);}
function personalReturnToChat(){personalPanel.open=false;if(nativeUi&&bridge){personalSetNativeOpen(false);window.parent.postMessage({type:'videoq:history-close',version:1,channel,videoId:bridge.videoId},nativeUi.origin);}}
async function personalRequest(payload){
 const response=await fetch('/api/lti/conversations',{method:'POST',credentials:'omit',signal:AbortSignal.timeout(30000),headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body:JSON.stringify(payload)});
 if(!response.ok){if(response.status===403||response.status===401)personalAvailability(false);if(response.status===404){personalDetail=null;personalItems=[];if(payload.conversationId===activeConversationId){activeConversationId=crypto.randomUUID();resumePersonalConversation=false;replaceChatHistory([]);}}const data=await response.json().catch(()=>null);throw new Error(data?.error?.code==='CONVERSATION_BUSY'?personalCopy.busy:personalCopy.error);}
 const data=await response.json();personalAvailability(true);return data;
}
async function personalRun(operation,initial=false){
 if(personalBusy||(!initial&&(!sessionReady||chatInFlight)))return;personalBusy=true;personalError='';syncComposer();personalDraw();
 try{await operation();}catch(error){personalError=error.message||personalCopy.error;}finally{personalBusy=false;syncComposer();personalDraw();}
}
async function personalList(){const data=await personalRequest({action:'list',limit:20,offset:personalPage*20});personalItems=data.items;personalHasMore=data.hasMore;personalDetail=null;}
async function personalLoad(id,beforeTurnId){personalDetail=await personalRequest({action:'get',conversationId:id,limit:50,...(beforeTurnId?{beforeTurnId}:{})});personalOlder=!!beforeTurnId;}
async function personalContinue(id){if(!learningEnabled)return;const detail=await personalRequest({action:'get',conversationId:id,limit:50});activeConversationId=id;resumePersonalConversation=true;replaceChatHistory(detail.turns);personalReturnToChat();}
function personalNew(){if(personalBusy||send.disabled||personalAllowed!==true)return;activeConversationId=crypto.randomUUID();resumePersonalConversation=false;replaceChatHistory([]);personalDetail=null;personalReturnToChat();personalDraw();}
function personalMessageInput(){return activeConversationId?{conversationId:activeConversationId,resumeConversation:resumePersonalConversation}:{};}
function personalCommitted(){if(activeConversationId)resumePersonalConversation=true;personalDraw();}
async function personalInit(){
 if(!features.conversations||personalInitialized)return;personalInitialized=true;personalLegacy=history.length>0;
 await personalRun(async()=>{await personalList();if(personalItems.length&&learningEnabled)await personalContinue(personalItems[0].id);else{activeConversationId=crypto.randomUUID();resumePersonalConversation=false;replaceChatHistory([]);}},true);
}
async function personalRecent(){const response=await fetch('/api/lti/history',{method:'POST',credentials:'omit',signal:AbortSignal.timeout(30000),headers:{Authorization:'Bearer '+token}});if(!response.ok)throw new Error(personalCopy.error);const data=await response.json();activeConversationId=null;resumePersonalConversation=false;replaceChatHistory(data.turns||[]);personalReturnToChat();}
async function personalDelete(id){
 if(!await qaConfirm(personalCopy.confirm,personalCopy.delete))return;
 await personalRequest({action:'delete',conversationId:id});
 if(activeConversationId===id){activeConversationId=crypto.randomUUID();resumePersonalConversation=false;replaceChatHistory([]);}
 await personalList();
}
async function personalExport(id){
 const pages=[];let cursor,metadata;
 while(true){const page=await personalRequest({action:'export',conversationId:id,limit:100,...(cursor?{beforeTurnId:cursor}:{})});metadata??={format:'videoq-personal-conversation-v1',id:page.id,title:page.title,createdAt:page.createdAt,updatedAt:page.updatedAt};pages.unshift(page.turns);if(!page.hasMore)break;const next=page.turns[0]?.id;if(!next||next===cursor)throw new Error(personalCopy.error);cursor=next;}
 const parts=[JSON.stringify({type:'conversation',...metadata})+'\\n'];for(const page of pages)for(const turn of page)parts.push(JSON.stringify({type:'turn',...turn})+'\\n');
 const blob=new Blob(parts,{type:'application/x-ndjson'}),url=URL.createObjectURL(blob),link=document.createElement('a');link.href=url;link.download='videoq-conversation-'+id+'.ndjson';document.body.append(link);link.click();link.remove();setTimeout(()=>URL.revokeObjectURL(url),30000);
}
function personalButton(label,operation,requiresLearning=false){return qaButton(label,()=>personalRun(operation),{disabled:personalBusy||!sessionReady||chatInFlight||(requiresLearning&&!learningEnabled)});}
function personalDraw(){
 personalStatus.dataset.error=String(!!personalError);personalStatus.textContent=personalBusy?personalCopy.loading:personalError;personalPanel.setAttribute('aria-busy',String(personalBusy));personalContent.replaceChildren();
 if(personalAllowed!==true){if(!personalBusy&&personalAllowed!==false)personalContent.append(personalButton(personalCopy.refresh,personalList));return;}
 const actions=qaNode('div','','qa-row');actions.append(qaButton(personalCopy.new,personalNew,{disabled:personalBusy||send.disabled}),personalButton(personalCopy.refresh,personalList));if(personalLegacy)actions.append(personalButton(personalCopy.recent,personalRecent));personalContent.append(actions);
 if(personalDetail){
  const detail=personalDetail,row=qaNode('div','','qa-row');personalContent.append(qaNode('h2',detail.title));row.append(personalButton(personalCopy.back,personalList),personalButton(personalCopy.continue,()=>personalContinue(detail.id),true),personalButton(personalCopy.export,()=>personalExport(detail.id)),personalButton(personalCopy.delete,()=>personalDelete(detail.id)));personalContent.append(row);
  for(const turn of detail.turns){const card=qaNode('article','','qa-card');card.append(qaNode('h3',personalCopy.question),qaNode('p',turn.question,'personal-turn'),qaNode('h3',personalCopy.answer),qaNode('p',turn.answer.segments.map(segment=>segment.text).join(''),'personal-turn'));for(const source of turn.answer.sources)card.append(citation(source));personalContent.append(card);}
  const paging=qaNode('div','','qa-row');if(detail.hasMore&&detail.turns.length)paging.append(personalButton(personalCopy.older,()=>personalLoad(detail.id,detail.turns[0].id)));if(personalOlder)paging.append(personalButton(personalCopy.latest,()=>personalLoad(detail.id)));personalContent.append(paging);return;
 }
 for(const item of personalItems){const card=qaNode('article','','qa-card'),row=qaNode('div','','qa-row');card.append(qaNode('h2',item.title));const time=qaNode('time',new Date(item.updatedAt).toLocaleString(document.documentElement.lang),'qa-meta');time.dateTime=item.updatedAt;card.append(time);row.append(personalButton(personalCopy.open,()=>personalLoad(item.id)),personalButton(personalCopy.continue,()=>personalContinue(item.id),true),personalButton(personalCopy.export,()=>personalExport(item.id)),personalButton(personalCopy.delete,()=>personalDelete(item.id)));card.append(row);personalContent.append(card);}
 if(!personalItems.length)personalContent.append(qaNode('p',personalCopy.empty));const paging=qaNode('div','','qa-row');paging.append(qaButton(personalCopy.previous,()=>personalRun(async()=>{personalPage--;await personalList();}),{disabled:personalBusy||!sessionReady||chatInFlight||personalPage===0}),qaNode('span',String(personalPage+1)),qaButton(personalCopy.next,()=>personalRun(async()=>{personalPage++;await personalList();}),{disabled:personalBusy||!sessionReady||chatInFlight||!personalHasMore}));personalContent.append(paging);
}
personalPanel.addEventListener('toggle',()=>{if(personalPanel.open&&!nativeUi)void personalRun(personalList);});
`;
}
