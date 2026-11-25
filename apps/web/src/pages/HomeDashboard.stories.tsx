import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, waitFor } from 'storybook/test';
import HomeDashboard from './HomeDashboard';
import i18n from '@/i18n/config';
import { authFixture, regularUser } from '../../.storybook/fixtures/auth';
import { pending, success, trpcQuery } from '../../.storybook/mocks/network';
import { uploadedVideo } from '../../.storybook/fixtures/videos';
import type { VideoList } from '@/lib/api';
import type { CourseListItem, VideoStatus } from '@videoq/trpc';

const basic = {
  ...regularUser, plan_code: 'basic' as const,
  used_storage_bytes: 10 * 1024 ** 3, storage_limit_bytes: 20 * 1024 ** 3,
  used_upload_bytes: 200 * 1024 ** 3, monthly_upload_limit_bytes: 200 * 1024 ** 3,
  used_processing_seconds: 120 * 60, processing_limit_seconds: 200 * 60,
  used_ai_answers: 100, ai_answers_limit: 500,
};
const meta = {
  title: 'Pages/HomeDashboard', component: HomeDashboard,
  parameters: { pathname: '/', api: { auth: authFixture(basic), trpc: [
    trpcQuery('videos.list', success({ data: [], meta: { total: 0, offset: 0, limit: 5 } })),
    trpcQuery('courses.list', success({ data: [], meta: { total: 0, offset: 0, limit: 1 } })),
    trpcQuery('videos.statusCounts', success({ total: 0, completed: 0, pending: 0, processing: 0, indexing: 0, error: 0, uploading: 0 })),
  ] } },
} satisfies Meta<typeof HomeDashboard>;
export default meta;
type Story = StoryObj<typeof meta>;

export const MonthlyAllowanceUsed: Story = {
  async play({ canvas, canvasElement }) {
    const monthly = await canvas.findByText(i18n.t('quota.usage.monthlyUpload'));
    await waitFor(() => expect(monthly.parentElement).toHaveTextContent('200GB/200GB'));
    await expect(canvas.getByText(i18n.t('quota.usage.storage')).parentElement).toHaveTextContent('10GB/20GB');
    await expect(canvasElement.scrollWidth).toBeLessThanOrEqual(canvasElement.clientWidth);
  },
};
export const EnglishMobile: Story = {
  ...MonthlyAllowanceUsed, globals: { locale: 'en', viewport: { value: 'mobile', isRotated: false } },
};

const newcomer = { ...regularUser, used_ai_answers: 0 };
const statusCounts = (counts: Partial<Record<'total' | 'completed' | 'processing', number>>) => ({
  total: 0, completed: 0, pending: 0, processing: 0, indexing: 0, error: 0, uploading: 0, ...counts,
});
const video = (status: VideoStatus): VideoList => ({ ...uploadedVideo, status });
const course: CourseListItem = {
  id: 3, name: '線形代数', description: '', display_order: 0, created_at: '2026-09-01T09:00:00Z', video_count: 1, access_role: 'owner',
};
const guideApi = (videos: VideoList[], counts: ReturnType<typeof statusCounts>, courses: CourseListItem[] = []) => ({
  auth: authFixture(newcomer),
  trpc: [
    trpcQuery('chat.history', success({ data: [], meta: { total: 0, offset: 0, limit: 1 } })),
    trpcQuery('videos.list', success({ data: videos, meta: { total: videos.length, offset: 0, limit: 5 } })),
    trpcQuery('courses.list', success({ data: courses, meta: { total: courses.length, offset: 0, limit: 1 } })),
    trpcQuery('videos.statusCounts', success(counts)),
  ],
});
const findGuide = (canvas: Parameters<NonNullable<Story['play']>>[0]['canvas']) =>
  canvas.findByRole('region', { name: i18n.t('home.gettingStarted.title') });

export const GettingStartedNewUser: Story = {
  parameters: { api: guideApi([], statusCounts({})) },
  async play({ canvas }) {
    const guide = await findGuide(canvas);
    await expect(guide).toHaveTextContent(i18n.t('home.gettingStarted.steps.upload.action'));
    await expect(canvas.queryByText(i18n.t('home.gettingStarted.steps.ask.description'))).not.toBeInTheDocument();
    await expect(canvas.queryByText(i18n.t('home.stats.summaryTitle'))).not.toBeInTheDocument();
  },
};
export const GettingStartedTranscribing: Story = {
  parameters: { api: guideApi([video('processing')], statusCounts({ total: 1, processing: 1 })) },
  async play({ canvas }) {
    await expect(await findGuide(canvas)).toHaveTextContent(i18n.t('home.gettingStarted.processing'));
  },
};
export const GettingStartedCreateCourse: Story = {
  parameters: { api: guideApi([video('completed')], statusCounts({ total: 1, completed: 1 })) },
  async play({ canvas }) {
    await findGuide(canvas);
    await expect(canvas.getByRole('link', { name: i18n.t('home.gettingStarted.steps.course.action') })).toBeInTheDocument();
  },
};
export const GettingStartedReadyToAsk: Story = {
  parameters: { api: guideApi([video('completed')], statusCounts({ total: 1, completed: 1 }), [course]) },
  async play({ canvas }) {
    await findGuide(canvas);
    await expect(canvas.getByRole('link', { name: i18n.t('home.gettingStarted.steps.ask.action') })).toBeInTheDocument();
  },
};
export const GettingStartedEnglishMobile: Story = {
  ...GettingStartedNewUser, globals: { locale: 'en', viewport: { value: 'mobile', isRotated: false } },
};

export const CoursesLoading: Story = {
  parameters: { api: { auth: authFixture(basic), trpc: [
    trpcQuery('videos.list', success({ data: [uploadedVideo], meta: { total: 1, offset: 0, limit: 5 } })),
    trpcQuery('courses.list', pending()),
    trpcQuery('videos.statusCounts', success(statusCounts({ total: 1, completed: 1 }))),
  ] } },
  async play({ canvas }) {
    await expect(await canvas.findByText(uploadedVideo.title)).toBeVisible();
    await expect(canvas.getByText(i18n.t('home.usage.title'))).toBeVisible();
    await expect(canvas.getAllByRole('progressbar')[0]).toBeVisible();
  },
};
export const CoursesLoadingMobile: Story = {
  ...CoursesLoading, globals: { locale: 'ja', viewport: { value: 'mobile', isRotated: false } },
};
