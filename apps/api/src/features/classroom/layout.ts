import { courseHistoryMarkup } from '../lti/course-history-view';
import type { LtiLocale } from '../lti/locale';

const copy = {
  ja: { videos: '動画一覧', assistant: 'AIアシスタント', details: '詳細', overview: '概要', qa: 'Q&A',
    panels: '学習パネル', learningDetails: '教材の詳細', chooseVideo: '動画を選択してください', hidePlayer: '動画を隠す', showPlayer: '動画を表示',
    refresh: '一覧を更新', emptyOverview: 'この動画の説明はありません。',
    course: '教材', account: 'アカウント', count: '本の動画' },
  en: { videos: 'Videos', assistant: 'AI assistant', details: 'Details', overview: 'Overview', qa: 'Q&A',
    panels: 'Learning panels', learningDetails: 'Material details', chooseVideo: 'Select a video', hidePlayer: 'Hide video', showPlayer: 'Show video',
    refresh: 'Refresh videos', emptyOverview: 'No description is available for this video.',
    course: 'Material', account: 'Account', count: 'videos' },
} as const;
const icons = {
  videos: '<path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01"/>',
  assistant: '<path d="m12 3 2.5 6.5L21 12l-6.5 2.5L12 21l-2.5-6.5L3 12l6.5-2.5z"/>',
  details: '<path d="M4 6h16M4 12h16M4 18h10"/>',
  qa: '<path d="M21 11a8 8 0 0 1-8 8H7l-4 3V11a9 9 0 0 1 18 0Z"/>',
};
function icon(name: keyof typeof icons) {
  return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${icons[name]}</svg>`;
}
function tab(group: 'side' | 'detail', name: string, label: string, selected: boolean, image?: keyof typeof icons) {
  return `<button type="button" role="tab" id="classroom-${group}-tab-${name}" aria-controls="classroom-${group}-panel-${name}" aria-selected="${selected}" tabindex="${selected ? 0 : -1}" data-classroom-tab="${group}:${name}">${image ? icon(image) : ''}<span>${label}</span></button>`;
}
export function classroomViewerHeader(locale: LtiLocale) {
  const c = copy[locale];
  return `<header class="chat-header classroom-viewer-header"><span class="classroom-wordmark">VideoQ</span><span class="classroom-header-divider" aria-hidden="true"></span><h1 id="classroom-material-title">${c.course}</h1><span class="classroom-context">Classroom</span><details class="classroom-account-menu"><summary>${c.account}</summary><div id="classroom-account-actions"></div></details></header>`;
}
export function classroomPlayerMarkup(locale: LtiLocale) {
  const c = copy[locale];
  return `<section id="classroom-player" hidden><div id="classroom-player-media"><video id="classroom-media" controls playsinline hidden></video><iframe id="classroom-youtube" title="${c.course}" hidden allow="autoplay; encrypted-media; fullscreen" allowfullscreen></iframe></div><div class="classroom-player-heading"><h2 id="classroom-video-title">${c.chooseVideo}</h2><button type="button" id="classroom-player-toggle" aria-expanded="true" aria-controls="classroom-player-media">${c.hidePlayer}</button></div><p id="classroom-player-status" role="status"></p></section>`;
}
export function classroomDetailsMarkup(locale: LtiLocale, materials: string, qa: string) {
  const c = copy[locale];
  return `<section id="classroom-details"><div class="classroom-tabs" role="tablist" aria-label="${c.learningDetails}">${tab('detail', 'overview', c.overview, true, 'details')}${tab('detail', 'qa', c.qa, false, 'qa')}</div><section id="classroom-detail-panel-overview" role="tabpanel" aria-labelledby="classroom-detail-tab-overview" tabindex="0"><h3 id="classroom-overview-title">${c.overview}</h3><p id="classroom-overview-description">${c.emptyOverview}</p></section><section id="classroom-detail-panel-qa" role="tabpanel" aria-labelledby="classroom-detail-tab-qa" tabindex="0" hidden>${qa}</section><div hidden>${materials}</div></section>`;
}
export function classroomSidebarStart(locale: LtiLocale, history: string) {
  const c = copy[locale];
  return `<aside class="classroom-sidebar"><div class="classroom-tabs" role="tablist" aria-label="${c.panels}">${tab('side', 'videos', c.videos, false, 'videos')}${tab('side', 'assistant', c.assistant, true, 'assistant')}${tab('side', 'details', c.details, false, 'details')}</div><section id="classroom-side-panel-videos" role="tabpanel" aria-labelledby="classroom-side-tab-videos" tabindex="0" hidden><div class="classroom-video-toolbar"><span id="classroom-video-count"></span><button id="classroom-videos-refresh" type="button">${c.refresh}</button></div><select id="classroom-video" aria-label="${c.videos}" hidden></select><ol id="classroom-video-list"></ol></section><section id="classroom-side-panel-details" role="tabpanel" aria-labelledby="classroom-side-tab-details" tabindex="0" hidden></section><section id="classroom-side-panel-assistant" class="classroom-chat" role="tabpanel" aria-labelledby="classroom-side-tab-assistant">${courseHistoryMarkup(locale)}<div hidden>${history}</div>`;
}
/** Match the core viewer's tabs and responsive placement while preserving the mounted player. */
export function classroomLayoutScript(locale: LtiLocale) {
  return `
const classroomLayoutCopy=${JSON.stringify(copy[locale])};
const classroomNarrow=window.matchMedia('(max-width: 1023px)');
const classroomDetails=document.getElementById('classroom-details'),classroomLearning=document.getElementById('classroom-learning');
let classroomSideTab='assistant',classroomDetailTab='overview',classroomPlayerExpanded=true;
function classroomChooseTab(group,name,focus=false){
 const buttons=[...document.querySelectorAll('[data-classroom-tab^="'+group+':"]')].filter(button=>!button.hidden&&!button.disabled);
 const selected=buttons.find(button=>button.dataset.classroomTab===group+':'+name);if(!selected)return;
 if(group==='side')classroomSideTab=name;else classroomDetailTab=name;
 for(const button of buttons){const active=button===selected;button.setAttribute('aria-selected',String(active));button.tabIndex=active?0:-1;document.getElementById(button.getAttribute('aria-controls')).hidden=!active;}
 if(focus)selected.focus();
 if(group==='detail'&&name==='qa')qaPanel.open=true;
}
for(const button of document.querySelectorAll('[data-classroom-tab]')){
 const [group,name]=button.dataset.classroomTab.split(':');
 button.addEventListener('click',()=>classroomChooseTab(group,name));
 button.addEventListener('keydown',event=>{
  const buttons=[...button.parentElement.querySelectorAll('[role="tab"]')].filter(item=>!item.hidden&&!item.disabled),index=buttons.indexOf(button);
  const target={ArrowRight:buttons[(index+1)%buttons.length],ArrowLeft:buttons[(index-1+buttons.length)%buttons.length],Home:buttons[0],End:buttons.at(-1)}[event.key];
  if(!target)return;event.preventDefault();classroomChooseTab(group,target.dataset.classroomTab.split(':')[1],true);
 });
}
function classroomSetPlayerExpanded(expanded){classroomPlayerExpanded=expanded;document.getElementById('classroom-player-media').hidden=classroomNarrow.matches&&!expanded;const toggle=document.getElementById('classroom-player-toggle');toggle.setAttribute('aria-expanded',String(expanded));toggle.textContent=expanded?classroomLayoutCopy.hidePlayer:classroomLayoutCopy.showPlayer;}
function classroomRevealPlayer(){classroomSetPlayerExpanded(true);classroomLearning.scrollTop=0;}
document.getElementById('classroom-player-toggle').addEventListener('click',()=>classroomSetPlayerExpanded(!classroomPlayerExpanded));
question.addEventListener('focus',()=>{if(classroomNarrow.matches)classroomSetPlayerExpanded(false);});
function classroomArrangeViewer(){
 const mobile=classroomNarrow.matches;document.getElementById('classroom-side-tab-details').hidden=!mobile;
 (mobile?document.getElementById('classroom-side-panel-details'):classroomLearning).append(classroomDetails);
 if(!mobile&&classroomSideTab==='details')classroomSideTab='assistant';
 document.getElementById('classroom-side-panel-details').hidden=!(mobile&&classroomSideTab==='details');
 classroomChooseTab('side',classroomSideTab);classroomSetPlayerExpanded(classroomPlayerExpanded);
}
classroomNarrow.addEventListener('change',classroomArrangeViewer);classroomArrangeViewer();
window.addEventListener('pagehide',()=>classroomNarrow.removeEventListener('change',classroomArrangeViewer),{once:true});
function classroomVideoChanged(video){
 document.getElementById('classroom-video-title').textContent=video.title||classroomLayoutCopy.course;
 document.getElementById('classroom-overview-title').textContent=video.title||classroomLayoutCopy.overview;
 document.getElementById('classroom-overview-description').textContent=video.description?.trim()||classroomLayoutCopy.emptyOverview;
 for(const button of document.querySelectorAll('[data-classroom-video]')){const active=Number(button.dataset.classroomVideo)===classroomSelected;button.setAttribute('aria-pressed',String(active));}
 classroomRevealPlayer();
}
function classroomSyncTranscriptSelection(){if(classroomSelected&&[...materialSelect.options].some(option=>Number(option.value)===classroomSelected))materialSelect.value=String(classroomSelected);}
`;
}
