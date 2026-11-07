import type { LtiLocale } from './locale';

const copies = {
  en: { title: 'AI question usage', notice: 'Counts include verified Moodle AI answers whose complete original material scope is currently readable by you. Older answers without verified course provenance are excluded. Dates use UTC. Private questions, answers and learner identities are not included.',
    from: 'From', to: 'To', load: 'Refresh report', csv: 'Download aggregate CSV', close: 'Return to questions',
    questions: 'Questions', good: 'Helpful', bad: 'Not helpful', none: 'Unrated', date: 'Date',
    empty: 'No matching AI questions in this period and material scope.', loading: 'Loading…', error: 'The report is unavailable. Check the dates and your current Moodle permissions.',
    unavailable: 'Course reports are unavailable. Check your current Moodle permissions or relaunch.' },
  ja: { title: 'AI質問の利用状況', notice: '元の教材範囲を現在すべて閲覧できる、所属コース確認済みのMoodle経由のAI回答を集計します。所属コースを確認できない過去の回答は含みません。日付はUTCです。個人の質問・回答本文や学習者の識別情報は表示しません。',
    from: '開始日', to: '終了日', load: 'レポートを更新', csv: '集計CSVをダウンロード', close: '質問画面に戻る',
    questions: '質問数', good: '役に立った', bad: '役に立たなかった', none: '未評価', date: '日付',
    empty: 'この期間と教材範囲に該当するAI質問はありません。', loading: '読み込み中…', error: 'レポートを取得できません。日付と現在のMoodle権限を確認してください。',
    unavailable: 'レポートを利用できません。現在のMoodle権限を確認するか、開き直してください。' },
} as const;

export function reportMarkup(locale: LtiLocale) {
  const c = copies[locale];
  return `<details id="course-reports" hidden><summary>${c.title}</summary><p>${c.notice}</p>
<form id="reports-form"><label>${c.from}<input id="reports-from" type="date" required></label><label>${c.to}<input id="reports-to" type="date" required></label>
<button type="submit" class="qa-button">${c.load}</button><button id="reports-export" type="button" class="qa-button" disabled>${c.csv}</button>
<button id="reports-close" type="button" class="qa-button" hidden>${c.close}</button></form><p id="reports-status" role="status" aria-live="polite"></p><div id="reports-content"></div></details>`;
}
export const reportStyles = `
#course-reports{border-top:1px solid #e1e5ea;padding:16px 0;overflow:auto}#course-reports[hidden]{display:none!important}
#reports-form{display:flex;gap:8px;flex-wrap:wrap;align-items:end}#reports-form label{display:flex;flex-direction:column;gap:4px;min-width:0}
#reports-form input{font:inherit;max-width:100%;padding:6px}#reports-content table{border-collapse:collapse;width:100%;font-size:13px;table-layout:fixed}
#reports-content th,#reports-content td{border-bottom:1px solid #e1e5ea;text-align:left;padding:8px 3px;overflow-wrap:anywhere}
#reports-content dl{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:6px 12px}#reports-content dt{font-weight:600}#reports-content dd{margin:0;text-align:right}
.reports-open #messages,.reports-open .composer,.reports-open #course-materials,.reports-open #course-qa,.reports-open #personal-history,.reports-open #material-management,.reports-open #course-tags{display:none!important}
.reports-open #course-reports{display:block;flex:1;max-height:none;border:0}.moodle-reports #course-reports>summary{display:none}
.moodle-qa #course-reports,.moodle-personal-history #course-reports,.moodle-management #course-reports,.moodle-tags #course-reports{display:none!important}
`;

export function reportClientScript(locale: LtiLocale) {
  const c = JSON.stringify(copies[locale]).replaceAll('<', '\\u003c');
  return `
const reportsCopy=${c},reportsPanel=document.getElementById('course-reports'),reportsContent=document.getElementById('reports-content'),reportsStatus=document.getElementById('reports-status'),reportsForm=document.getElementById('reports-form'),reportsFrom=document.getElementById('reports-from'),reportsTo=document.getElementById('reports-to');
let reportsAllowed=null,reportsOpen=false,reportsBusy=false,reportsData=null,reportsEpoch=0;
const reportsToday=new Date();reportsTo.value=reportsToday.toISOString().slice(0,10);reportsToday.setUTCDate(reportsToday.getUTCDate()-29);reportsFrom.value=reportsToday.toISOString().slice(0,10);
function reportsLock(){for(const el of reportsForm.elements)el.disabled=reportsBusy||reportsAllowed!==true;document.getElementById('reports-export').disabled=reportsBusy||!reportsData||reportsAllowed!==true;document.getElementById('reports-close').disabled=false;reportsPanel.setAttribute('aria-busy',String(reportsBusy));}
function reportsAvailability(value){reportsAllowed=features.reports===true&&value===true;if(!reportsAllowed){reportsEpoch++;reportsData=null;reportsContent.replaceChildren();reportsStatus.textContent='';if(reportsOpen)reportsSetNativeOpen(false);}
 reportsPanel.hidden=nativeUi?!reportsOpen:!reportsAllowed;reportsLock();if(nativeUi&&bridge)window.parent.postMessage({type:'videoq:reports-availability',version:1,channel,videoId:bridge.videoId,available:reportsAllowed},nativeUi.origin);}
function reportsEnterNative(){reportsPanel.hidden=!reportsOpen;document.body.classList.toggle('moodle-reports',reportsOpen);if(reportsAllowed!==null)reportsAvailability(reportsAllowed);}
function reportsSetNativeOpen(open){reportsOpen=open===true&&reportsAllowed===true;document.body.classList.toggle('reports-open',reportsOpen);document.body.classList.toggle('moodle-reports',Boolean(nativeUi)&&reportsOpen);reportsPanel.hidden=nativeUi?!reportsOpen:reportsAllowed!==true;reportsPanel.open=reportsOpen;document.getElementById('reports-close').hidden=!reportsOpen;if(reportsOpen){reportsPanel.scrollTop=0;void reportsLoad();}}
function reportsRender(){reportsContent.replaceChildren();if(!reportsData||reportsAllowed!==true)return;const totals=reportsData.totals;const summary=qaNode('dl');for(const key of ['questions','good','bad','none'])summary.append(qaNode('dt',reportsCopy[key]),qaNode('dd',String(totals[key])));reportsContent.append(summary);if(!reportsData.days.length){reportsContent.append(qaNode('p',reportsCopy.empty));return;}
 const table=qaNode('table'),head=qaNode('thead'),row=qaNode('tr');for(const key of ['date','questions','good','bad','none']){const th=qaNode('th',reportsCopy[key]);th.scope='col';row.append(th);}head.append(row);table.append(head);const body=qaNode('tbody');for(const day of reportsData.days){const tr=qaNode('tr');for(const key of ['date','questions','good','bad','none'])tr.append(qaNode('td',String(day[key])));body.append(tr);}table.append(body);reportsContent.append(table);}
async function reportsLoad(){if(reportsBusy||!sessionReady||chatInFlight||reportsAllowed!==true)return false;reportsBusy=true;reportsData=null;reportsRender();reportsStatus.textContent=reportsCopy.loading;reportsLock();
 try{const epoch=reportsEpoch,payload={action:'summary',from:reportsFrom.value,to:reportsTo.value};
 // The report endpoint itself reauthorizes every read, including CSV reloads.
 const response=await fetch('/api/lti/reports',{method:'POST',credentials:'omit',signal:AbortSignal.timeout(30000),headers:{'Content-Type':'application/json',Authorization:'Bearer '+token},body:JSON.stringify(payload)});
 if(!response.ok){if([401,403].includes(response.status))reportsAvailability(false);throw new Error(reportsCopy.error);}
 const data=await response.json();if(epoch!==reportsEpoch||reportsAllowed!==true)return false;
 const count=n=>Number.isSafeInteger(n)&&n>=0;if(data.period?.from!==payload.from||data.period?.to!==payload.to||data.period?.timezone!=='UTC'||data.coverage!=='verified-moodle-resource-scope'||!Array.isArray(data.days)||data.days.length>366||!['questions','good','bad','none'].every(key=>count(data.totals?.[key]))||data.days.some(row=>!/^\\d{4}-\\d{2}-\\d{2}$/.test(row.date)||!['questions','good','bad','none'].every(key=>count(row[key]))))throw new Error(reportsCopy.error);
 reportsData=data;reportsStatus.textContent='';reportsRender();return true;
 }catch{reportsData=null;reportsRender();reportsStatus.textContent=reportsAllowed===false?reportsCopy.unavailable:reportsCopy.error;return false;}finally{reportsBusy=false;reportsLock();}}
reportsForm.addEventListener('submit',event=>{event.preventDefault();void reportsLoad();});
document.getElementById('reports-export').addEventListener('click',async()=>{if(!await reportsLoad()||!reportsData)return;const lines=['date,questions,good,bad,unrated',...reportsData.days.map(row=>[row.date,row.questions,row.good,row.bad,row.none].join(','))];const url=URL.createObjectURL(new Blob([lines.join('\\n')+'\\n'],{type:'text/csv;charset=utf-8'})),link=qaNode('a');link.href=url;link.download='videoq-usage-'+reportsData.period.from+'_'+reportsData.period.to+'.csv';document.body.append(link);link.click();link.remove();setTimeout(()=>URL.revokeObjectURL(url),30000);});
document.getElementById('reports-close').addEventListener('click',()=>{reportsSetNativeOpen(false);if(nativeUi&&bridge)window.parent.postMessage({type:'videoq:reports-close',version:1,channel,videoId:bridge.videoId},nativeUi.origin);});
reportsPanel.addEventListener('toggle',()=>{if(!nativeUi)reportsSetNativeOpen(reportsPanel.open);});
async function reportsInit(){if(features.reports&&reportsAllowed===null){try{await materialRequest('list');}catch{reportsAvailability(false);}}}
`;
}
