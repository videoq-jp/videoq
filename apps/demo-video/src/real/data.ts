import { createContext, useContext } from 'react';
import { applyChatPart, plainChatAnswer, type ChatAnswer } from '@videoq/trpc/chat';
import { staticFile } from 'remotion';
import type { ChatHistoryItem, VideoCourse, VideoInCourse } from '@/lib/api';
import type { Message } from '@/hooks/useChatMessages';
import { createChatProgress, updateChatProgress } from '@/lib/chatProgress';
import type { ChatStreamEvent } from '@/lib/api-types';
import recording from '../../content/answer.json';
import course from '../../content/course.json';
import englishAd from '../../content/x-ad-en.json';
import type { Locale } from './film';

export const LocaleContext = createContext<Locale>('ja');
export const useLocale = () => useContext(LocaleContext);

export const demoUser = { id: 'demo-owner', username: 'VideoQ Demo', email: 'demo@videoq.jp', is_admin: false, video_count: 5, max_video_upload_size_mb: 500, plan_code: 'free' };
export const demoSlug = recording.course.slug;
export const shareLink = (locale: Locale) => `https://videoq.jp${locale === 'en' ? '/en' : ''}/share/${demoSlug}`;
export const cited = recording.course.videos[1];

const absolute = (file: string) => new URL(staticFile(file), window.location.origin).href;
const enLesson = ['writing-en', 'math-en'];

export function demoCourse(locale: Locale) {
  const english = locale === 'en';
  const videos = recording.course.videos.map((video, i) => ({
    id: video.id,
    title: english ? englishAd.titles[i] : video.title,
    description: '',
    // English has translated slides for the two lessons the film opens.
    file: english ? (enLesson[i] ? absolute(`generated/lessons/${enLesson[i]}.webm`) : null) : absolute(`generated/lessons/${course.lessons[i].key}.webm`),
    source_type: 'upload',
    status: 'completed',
    uploaded_at: recording.capturedAt,
    created_at: recording.capturedAt,
    updated_at: recording.capturedAt,
    tags: [],
  })) as unknown as VideoInCourse[];
  return {
    id: recording.course.id,
    name: english ? englishAd.courseName : recording.course.name,
    description: '',
    access_role: 'owner',
    share_slug: demoSlug,
    videos,
  } as unknown as VideoCourse & { videos: VideoInCourse[] };
}

const question = (locale: Locale) => (locale === 'en' ? englishAd.question : recording.question);

// The recorded stream replayed through the same reducers the app uses. English
// translates the recording's text and titles and keeps its citation range.
function streamEvents(locale: Locale): ChatStreamEvent[] {
  const events = recording.events as unknown as ChatStreamEvent[];
  if (locale === 'ja') return events;
  const titles = new Map(recording.course.videos.map((video, i) => [video.id, englishAd.titles[i]]));
  const text = Array.from(englishAd.answer, (letter): ChatStreamEvent => ({ type: 'text_delta', segmentIndex: 0, text: letter }));
  const first = events.findIndex(event => event.type === 'text_delta');
  const rest = events.slice(first).filter(event => event.type !== 'text_delta');
  return [
    ...events.slice(0, first).map(event => event.type === 'searching' || event.type === 'search_completed'
      ? { ...event, query: 'what a derivative represents' }
      : event.type === 'source' ? { ...event, source: { ...event.source, title: titles.get(event.source.video_id) ?? event.source.title } } : event),
    ...text,
    ...rest,
  ];
}

function replay(events: ChatStreamEvent[]): Message {
  const answer: ChatAnswer = { segments: [], sources: [] };
  let progress = createChatProgress();
  let chatLogId: number | undefined;
  for (const event of events) {
    progress = updateChatProgress(progress, event);
    if (event.type === 'source') answer.sources.push(event.source);
    if (event.type === 'text_delta') applyChatPart(answer, {type: 'text', segmentIndex: event.segmentIndex, text: event.text});
    if (event.type === 'citation') applyChatPart(answer, event);
    if (event.type === 'done') chatLogId = 1;
  }
  return { role: 'assistant', answer, progress, chatLogId, feedback: null };
}

export const greeting = (text: string): Message[] => [{ role: 'assistant', answer: plainChatAnswer(text) }];

/** Stream positions the timeline is keyed to: the first answer text, the citation and the end. */
export function streamMarks(locale: Locale) {
  const events = streamEvents(locale);
  return {
    text: events.findIndex(event => event.type === 'text_delta'),
    citation: events.findIndex(event => event.type === 'citation'),
    end: events.length,
  };
}

/** The conversation after `count` events of the recorded stream have arrived; null before sending. */
export function conversation(locale: Locale, greetingText: string, count: number | null): { messages: Message[]; isLoading: boolean } {
  if (count === null) return { messages: greeting(greetingText), isLoading: false };
  const events = streamEvents(locale);
  return {
    messages: [...greeting(greetingText), { role: 'user', content: question(locale) }, replay(events.slice(0, count))],
    isLoading: count < events.length,
  };
}

export function historyItems(locale: Locale): ChatHistoryItem[] {
  const answer = replay(streamEvents(locale));
  return [{
    id: 1,
    question: question(locale),
    answer: answer.role === 'assistant' ? answer.answer : plainChatAnswer(''),
    created_at: recording.capturedAt,
    asked_by: null,
    feedback: null,
    is_shared_origin: true,
  } as unknown as ChatHistoryItem];
}
