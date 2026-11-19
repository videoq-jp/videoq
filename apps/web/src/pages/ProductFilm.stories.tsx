import type { Meta, StoryObj } from '@storybook/react-vite';
import { http, HttpResponse } from 'msw';
import App from '@/App';
import type { VideoCourse, Video as VideoData, ChatHistoryItem } from '@/lib/api';
import { authFixtures } from '../../.storybook/fixtures/auth';
import { success, trpcQuery } from '../../.storybook/mocks/network';
import { installUploadFixture } from '../../.storybook/mocks/videoUpload';
import english from '../../../demo-video/content/x-ad-en.json';
import recording from '../../../demo-video/content/answer.json';
import mathVideo from '../../../demo-video/public/product-film-en/lesson.webm';

// A translated replay of the captured demo, never a newly generated AI answer.
// These routes run entirely in Storybook; invitations and uploads are simulated.
const tags = [{ id: 1, name: 'Foundations', color: 'blue' as const, created_at: recording.capturedAt, video_count: 5 }];
const transcript = '1\n00:00:00,000 --> 00:00:20,000\nA derivative measures the rate of change at an instant.\n\n2\n00:00:20,000 --> 00:00:54,000\nOn a graph, it is the slope of the tangent line.';
const videos: VideoData[] = recording.course.videos.map((video, i) => ({
  id: video.id, title: english.titles[i], description: 'University foundations · Original demo lesson',
  uploaded_at: recording.capturedAt, status: 'completed', source_type: 'uploaded',
  file: i === 1 ? mathVideo : null, transcript: i === 1 ? transcript : null, tags,
}));
const course: VideoCourse = {
  id: 3, name: english.courseName, description: 'Review the essentials. Ask questions across your course.',
  access_role: 'owner', display_order: 0, created_at: recording.capturedAt, video_count: 5,
  videos: [videos[1], videos[0], ...videos.slice(2)].map((video, order) => ({ ...video, order })),
};
const source = { id: 1, video_id: 4, title: english.titles[1], start_time: '00:00:00,000', end_time: '00:00:54,000' };
const history: ChatHistoryItem[] = [{
  id: 101, course: 3, asked_by: { user_id: 'demo-learner', username: 'Alex Taylor', email: 'learner@example.test' },
  question: english.question, answer: { segments: [{ text: english.answer, sourceIds: [1] }], sources: [source] },
  is_shared_origin: false, feedback: null, created_at: '2026-11-20T00:00:00Z',
}];
const page = <T,>(data: T[]) => ({ data, meta: { total: data.length, limit: 100, offset: 0 } });
const api = {
  auth: authFixtures.english,
  trpc: [
    trpcQuery('videos.list', success(page(videos))),
    trpcQuery('videos.get', success(videos[1])),
    trpcQuery('videos.statusCounts', success({ total: 5, completed: 5, processing: 0, pending: 0, indexing: 0, uploading: 0, error: 0 })),
    trpcQuery('tags.list', success(page(tags))),
    trpcQuery('courses.list', success(page([{ ...course, access_role: 'owner' as const }]))),
    trpcQuery('courses.get', success(course)),
    trpcQuery('chat.history', success(page(history))),
    trpcQuery('chat.conversations', success({ items: [], hasMore: false })),
    trpcQuery('courseMemberships.participants', success({ invitations: [], members: [] })),
  ],
  rest: [http.post('/api/chat/messages/stream', () => new HttpResponse([
    { type: 'source', source },
    { type: 'text_delta', segmentIndex: 0, text: english.answer },
    { type: 'citation', segmentIndex: 0, sourceId: 1 },
    { type: 'done', chat_log_id: 101, feedback: null },
  ].map(event => `data: ${JSON.stringify(event)}\n\n`).join(''), { headers: { 'Content-Type': 'text/event-stream' } }))],
};
const meta = {
  title: 'Films/English product walkthrough', component: App,
  globals: { locale: 'en' }, parameters: { layout: 'fullscreen', pathname: '/videos/courses/3', api },
  beforeEach() { return installUploadFixture({}); },
} satisfies Meta<typeof App>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Course: Story = {};
export const Library: Story = { parameters: { pathname: '/videos' } };
export const Upload: Story = { parameters: { pathname: '/videos?upload=true' } };
export const Video: Story = { parameters: { pathname: '/videos/4' } };
export const Member: Story = {
  parameters: { api: { ...api, trpc: [...api.trpc.filter(mock => mock.path !== 'courses.get'),
    trpcQuery('courses.get', success({ ...course, access_role: 'member' }))] } },
};
