import { useEffect, useLayoutEffect, useRef, type ReactNode } from 'react';
import { Route, Routes } from 'react-router-dom';
import { AbsoluteFill, Audio, Sequence, continueRender, delayRender, interpolate, staticFile, useCurrentFrame } from 'remotion';
import { AppPageShell } from '@/components/layout/AppPageShell';
import { VideoCourseDetailView } from '@/components/video/course-detail/VideoCourseDetailView';
import { ShareLinkDialog } from '@/components/video/course-detail/ShareLinkDialog';
import i18n from '@/i18n/config';
import SharePage from '@/pages/SharePage';
import VideoLibraryPage from '@/pages/VideoLibraryPage';
import { path, ramp, type Point } from './StudentDemo';
import copy from '../content/provider-copy.json';
import timeline from '../content/provider-timeline.json';
import studentTiming from '../content/provider-student-timeline.json';
import recording from '../content/answer.json';
import englishAd from '../content/x-ad-en.json';
import { FilmContext, type FilmState, type Locale } from './real/film';
import { conversation, cited, demoCourse, demoSlug, historyItems, shareLink, streamMarks } from './real/data';
import { ProductViewport, VIEWPORT, fontsReady } from './real/ProductViewport';
import { seekVideo } from './real/hooks/useVideoPlayback';
import { cameraFor, cursorFor } from './real/camera';

const noop = () => {};
const beats = timeline.owner;
const fit = 1680 / VIEWPORT.width;
const fade = (f:number, start:number, end:number) =>
  interpolate(f, [start, start + .25, end - .3, end], [0, 1, 1, 0], {extrapolateLeft:'clamp', extrapolateRight:'clamp'});
const greetingText = (locale:Locale) => i18n.getFixedT(locale)('chat.assistantGreeting');
const lessonTitle = (locale:Locale) => (locale === 'en' ? englishAd.titles[1] : cited.title);

function ProviderHeader({locale}:{locale:Locale}) {
  return <div className="film-top"><span className="wordmark">VideoQ<span> / FOR INSTRUCTORS</span></span><span className="film-tag">{copy[locale].tag}</span></div>;
}

function Caption({locale, index}:{locale:Locale; index:number}) {
  return <div className="film-caption"><span>{String(index + 1).padStart(2, '0')}</span>{copy[locale].captions[index]}</div>;
}

// Moves the film's camera and pointer over a real product screen. Coordinates
// are CSS pixels in the product's own viewport.
function ProductWindow({locale, path:route, state, f, opacity, camera, cursor, clicks, pointerHidden, children}:{
  locale:Locale; path:string; state:FilmState; f:number; opacity:number; camera:Point[]; cursor:Point[]; clicks:number[]; pointerHidden?:boolean; children:ReactNode;
}) {
  const c = path(f, camera), p = path(f, cursor);
  const tx = Math.max(1680 * (1 - c.z), Math.min(0, 840 - c.x * fit * c.z));
  const ty = Math.max(842 * (1 - c.z), Math.min(0, 421 - c.y * fit * c.z));
  const click = clicks.map(at => f - at).find(age => age >= 0 && age < .28);
  return <div className="film-window" style={{opacity}}>
    <div className="screen-camera" style={{transform:`translate(${tx}px,${ty}px) scale(${c.z * fit})`}}>
      <FilmContext.Provider value={state}>
        <ProductViewport locale={locale} path={route}>{children}</ProductViewport>
      </FilmContext.Provider>
    </div>
    <div className="cursor" style={{left:p.x * fit * c.z + tx, top:p.y * fit * c.z + ty, opacity:pointerHidden ? .15 : 1}}>
      {click !== undefined && <div className="click-ring" style={{transform:`translate(-50%,-50%) scale(${.45 + click / .24})`, opacity:1 - click / .28}}/>}
      <svg width="36" height="44" viewBox="0 0 30 40"><path d="M3 2v29l7-8 7 15 6-3-7-14h11z" fill="#172f3c" stroke="white" strokeWidth="2.4" strokeLinejoin="round"/></svg>
    </div>
  </div>;
}

// Runs after the page commits: applies browser state a prop cannot reach.
function AfterCommit({run}:{run:(doc:Document) => void}) {
  const marker = useRef<HTMLSpanElement>(null);
  const apply = () => { if (marker.current) run(marker.current.ownerDocument); };
  useLayoutEffect(apply);
  // Native dialogs open in the page's effects, which run after layout effects.
  useEffect(apply);
  return <span ref={marker} hidden/>;
}

function filmState(locale:Locale, overrides:Partial<FilmState> = {}):FilmState {
  return {
    chat:{...conversation(locale, greetingText(locale), null), input:''},
    history:historyItems(locale),
    playback:{videoId:cited.id, seconds:0},
    upload:{title:lessonTitle(locale), isUploading:false, progress:0, success:false},
    ...overrides,
  };
}

// The real course screen, with the real sharing dialog driven by the frame.
function CourseScreen({locale, shareOpen, copied, historyTab}:{locale:Locale; shareOpen:boolean; copied:boolean; historyTab:boolean}) {
  const course = demoCourse(locale);
  const videoRef = useRef<HTMLVideoElement>(null);
  useLayoutEffect(() => seekVideo(videoRef.current, 0), []);
  const selected = course.videos.find(video => video.id === cited.id) ?? null;
  const link = shareLink(locale);
  return <AppPageShell variant="workspace" activePage="courses">
    <VideoCourseDetailView course={course} courseId={course.id} isLoading={false} error={null} selectedVideo={selected}
      deleteError={null} isDeleting={false} removingVideoId={null} isReordering={false} isEditing={false} editedName={course.name}
      editedDescription="" updateError={null} isUpdating={false} isAddModalOpen={false} isMembersModalOpen={false} isLeaving={false}
      mobileTab="player" isMobile={false} videoRef={videoRef} youtubeStartSeconds={null} youtubeSeekId={0} shareSlug={demoSlug}
      shareLink={link} isGeneratingLink={false} isDeletingLink={false} isCopied={copied} onMobileTabChange={noop}
      onOpenAddModalChange={noop} onOpenMembersModalChange={noop} onStartEditing={noop} onCancelEdit={noop}
      onEditedNameChange={noop} onEditedDescriptionChange={noop} onUpdateCourse={noop} onDeleteCourse={noop} onLeaveGroup={noop}
      onVideoSelect={noop} onRemoveVideo={noop} onDragEnd={noop} onVideoCanPlay={noop} onVideoPlayFromTime={noop}
      onGenerateShareLink={noop} onDeleteShareLink={noop} onCopyShareLink={noop}/>
    {shareOpen && <ShareLinkDialog isOpen shareSlug={demoSlug} shareLink={link} isGeneratingLink={false} isDeletingLink={false}
      isCopied={copied} onOpenChange={noop} onGenerate={noop} onDelete={noop} onCopy={noop}/>}
    <AfterCommit run={doc => {
      const label = i18n.getFixedT(locale)(historyTab ? 'chat.history' : 'chat.newConsultation');
      const tab = Array.from(doc.querySelectorAll<HTMLButtonElement>('button[aria-pressed]')).find(button => button.textContent === label);
      if (tab?.getAttribute('aria-pressed') === 'false') tab.click();
    }}/>
  </AppPageShell>;
}

// The incoming messages illustrate the problem and are labelled as such; they
// are not product data.
function Hook({locale}:{locale:Locale}) {
  const f = useCurrentFrame() / timeline.fps;
  const text = copy[locale].hook;
  const headline = interpolate(f, [1.3, 1.6], [0, 1], {extrapolateLeft:'clamp', extrapolateRight:'clamp'});
  return <AbsoluteFill className="film">
    <ProviderHeader locale={locale}/>
    <div className="film-hook" style={{opacity:fade(f, 0, timeline.setup)}}>
      <h2 style={{opacity:headline, transform:`translateY(${(1 - headline) * 12}px)`}}>{text.title.map((line, i) => <span key={line}>{i > 0 && <br/>}{line}</span>)}</h2>
      <section className="hook-card">
        <div className="hook-title">{text.inbox}<small className="hook-illustration">{text.illustration}</small></div>
        {text.messages.map((message, i) => {
          const enter = ramp(f, .15 + i * .45, .45 + i * .45);
          return <div key={message} className="hook-message" style={{opacity:enter, transform:`translateY(${(1 - enter) * 18}px)`}}>{message}</div>;
        })}
      </section>
    </div>
    <Caption locale={locale} index={0}/>
  </AbsoluteFill>;
}

function OwnerSetup({locale}:{locale:Locale}) {
  const f = useCurrentFrame() / timeline.fps;
  const uploading = f >= beats.uploadClick && f < beats.uploadDone;
  const done = f >= beats.uploadDone;
  const state = filmState(locale, {upload:{title:lessonTitle(locale), isUploading:uploading, success:done,
    progress:interpolate(f, [beats.uploadClick, beats.uploadDone], [0, 100], {extrapolateLeft:'clamp', extrapolateRight:'clamp'})}});
  const opacity = fade(f, 0, timeline.student - timeline.setup);
  const body = f < beats.courseCut
    ? <ProductWindow key="library" locale={locale} path="/videos?upload=true" state={state} f={f} opacity={opacity} camera={cameraFor(locale).upload} cursor={cursorFor(locale).upload} clicks={[beats.uploadClick]}>
        <AppPageShell activePage="videoLibrary"><VideoLibraryPage/></AppPageShell>
        <AfterCommit run={doc => {
          const file = doc.querySelector<HTMLInputElement>('input[type=file]');
          if (file && !file.files?.length) {
            const chosen = new DataTransfer();
            chosen.items.add(new File([], 'lecture.mp4', {type:'video/mp4'}));
            file.files = chosen.files;
          }
          const scroll = doc.querySelector('.modal-dialog-scroll-area');
          // The progress bar sits below the form, as it does in a window this size.
          if (scroll) scroll.scrollTop = f >= beats.uploadClick ? scroll.scrollHeight : 0;
        }}/>
      </ProductWindow>
    : <ProductWindow key="course" locale={locale} path="/videos/courses/3" state={state} f={f} opacity={opacity} camera={cameraFor(locale).share} cursor={cursorFor(locale).share} clicks={[beats.shareClick, beats.copyClick]}>
        <CourseScreen locale={locale} shareOpen={f >= beats.shareClick} copied={f >= beats.copyClick} historyTab={false}/>
      </ProductWindow>;
  return <AbsoluteFill className="film">
    <ProviderHeader locale={locale}/>
    {body}
    <Caption locale={locale} index={f >= timeline.captions[2] - timeline.setup ? 2 : 1}/>
  </AbsoluteFill>;
}

const studentBeats = timeline.captions.slice(3, 7).map(at => at - timeline.student);

function StudentView({locale}:{locale:Locale}) {
  const f = useCurrentFrame() / timeline.fps;
  const t = studentTiming;
  const english = locale === 'en';
  const question = english ? englishAd.question : recording.question;
  const typed = Array.from(question).slice(0, Math.floor(interpolate(f, [t.typingStart, t.typingEnd], [0, Array.from(question).length], {extrapolateLeft:'clamp', extrapolateRight:'clamp'}))).join('');
  const marks = streamMarks(locale);
  const count = f < t.send ? null : Math.floor(interpolate(f, [t.send, t.answerStart, t.answerEnd, t.citation], [0, marks.text, marks.citation, marks.end], {extrapolateLeft:'clamp', extrapolateRight:'clamp'}));
  const state = filmState(locale, {
    chat:{...conversation(locale, greetingText(locale), count), input:f < t.send ? typed : ''},
    playback:{videoId:f < t.select ? recording.course.videos[0].id : cited.id, seconds:f >= t.playback ? f - t.playback : 0},
  });
  const step = studentBeats.filter(at => f >= at).length - 1;
  return <AbsoluteFill className="film">
    <ProviderHeader locale={locale}/>
    <ProductWindow locale={locale} path={`/share/${demoSlug}`} state={state} f={f}
      opacity={fade(f, 0, timeline.history - timeline.student)} camera={cameraFor(locale).student} cursor={cursorFor(locale).student}
      clicks={[t.focus, t.send, t.sourceClick]} pointerHidden={f > t.typingStart && f < t.typingEnd}>
      <Routes><Route path={`${english ? '/en' : ''}/share/:token`} element={<SharePage/>}/></Routes>
      <AfterCommit run={doc => {
        const input = doc.querySelector<HTMLInputElement>('input[aria-label]');
        if (f >= t.focus && f < t.send) input?.focus(); else input?.blur();
      }}/>
    </ProductWindow>
    <Caption locale={locale} index={3 + step}/>
  </AbsoluteFill>;
}

// The real history tab, showing the same recorded question and answer as above.
function OwnerHistory({locale}:{locale:Locale}) {
  const f = useCurrentFrame() / timeline.fps;
  return <AbsoluteFill className="film">
    <ProviderHeader locale={locale}/>
    <ProductWindow locale={locale} path="/videos/courses/3" state={filmState(locale)} f={f}
      opacity={fade(f, 0, timeline.outro - timeline.history)} camera={cameraFor(locale).history} cursor={cursorFor(locale).history} clicks={[beats.historyClick]}>
      <CourseScreen locale={locale} shareOpen={false} copied={false} historyTab={f >= beats.historyClick}/>
    </ProductWindow>
    <Caption locale={locale} index={7}/>
  </AbsoluteFill>;
}

function Outro({locale}:{locale:Locale}) {
  const f = useCurrentFrame() / timeline.fps;
  const text = copy[locale].outro;
  return <AbsoluteFill className="film">
    <AbsoluteFill className="outro" style={{opacity:ramp(f, 0, timeline.outroEnd - timeline.outro)}}>
      <div className="outro-mark">Q</div><p>{text.sub}</p>
      <h1>{text.title[0]}<br/>{text.title[1]}</h1>
      <div className="outro-cta">{text.cta} <span>→</span></div><small>{locale==='en'?'videoq.jp/en':'videoq.jp'}</small>
      <em className="outro-disclosure">{text.disclosure}</em>
    </AbsoluteFill>
  </AbsoluteFill>;
}

const seconds = (value:number) => Math.round(value * timeline.fps);

export function ProviderDemo({locale='ja'}:{locale?:Locale}) {
  const current = useCurrentFrame();
  useLayoutEffect(() => {
    const handle = delayRender('Loading fonts for the film text');
    void fontsReady(document).finally(() => continueRender(handle));
  }, [current]);
  return <AbsoluteFill className="provider-film">
    <Audio src={staticFile('audio/ambient.mp3')} volume={frame=>.30*interpolate(frame/timeline.fps,[0,.4,timeline.duration-1.5,timeline.duration],[0,1,1,0],{extrapolateLeft:'clamp',extrapolateRight:'clamp'})}/>
    <Sequence durationInFrames={seconds(timeline.setup)}><Hook locale={locale}/></Sequence>
    <Sequence from={seconds(timeline.setup)} durationInFrames={seconds(timeline.student - timeline.setup)}><OwnerSetup locale={locale}/></Sequence>
    <Sequence from={seconds(timeline.student)} durationInFrames={seconds(timeline.history - timeline.student)}><StudentView locale={locale}/></Sequence>
    <Sequence from={seconds(timeline.history)} durationInFrames={seconds(timeline.outro - timeline.history)}><OwnerHistory locale={locale}/></Sequence>
    <Sequence from={seconds(timeline.outro)}><Outro locale={locale}/></Sequence>
  </AbsoluteFill>;
}
