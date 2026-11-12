import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, waitFor } from 'storybook/test';
import App from '@/App';
import { installUploadFixture } from '../../.storybook/mocks/videoUpload';
import { authFixtures } from '../../.storybook/fixtures/auth';
import { course, detailVideo, libraryVideos } from '../../.storybook/fixtures/detail';
import { tagPage } from '../../.storybook/fixtures/api';
import { landingCourse } from '../../.storybook/fixtures/landing';
import { success, trpcQuery } from '../../.storybook/mocks/network';

// Full route previews cover the library and viewers as well as their surrounding
// navigation. Keep fixtures local so reviewing the UI never needs live accounts.
const page = <T,>(data: T[]) => ({ data, meta: { total: data.length, limit: 24, offset: 0 } });
const api = {
  auth: authFixtures.user,
  trpc: [
    trpcQuery('videos.list', success(page(libraryVideos))),
    trpcQuery('videos.get', success(detailVideo)),
    trpcQuery('videos.statusCounts', success({ total: 4, completed: 3, processing: 1, pending: 0, indexing: 0, uploading: 0, error: 0 })),
    trpcQuery('tags.list', success(tagPage)),
    trpcQuery('courses.list', success(page([{ ...course, access_role: 'owner' as const }]))),
    trpcQuery('courses.get', success(course)),
    trpcQuery('courses.shared', success({ ...landingCourse, videos: [{ ...landingCourse.videos[0], file: null }] })),
  ],
};
const meta = {
  title: 'Pages/Screen review', component: App,
  parameters: { layout: 'fullscreen', pathname: '/videos', api },
  beforeEach() { return installUploadFixture({}); },
  async play({ canvas }) {
    await expect(await canvas.findByRole('heading', { level: 1 }, { timeout: 15000 })).toBeVisible();
    await waitFor(() => expect(canvas.queryByRole('progressbar', { name: /読み込み中|Loading/i })).not.toBeInTheDocument(), { timeout: 15000 });
  },
} satisfies Meta<typeof App>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Library: Story = {};
export const Video: Story = { parameters: { pathname: '/videos/7' } };
export const Courses: Story = { parameters: { pathname: '/videos/courses' } };
export const Course: Story = { parameters: { pathname: '/videos/courses/42' } };
export const SharedCourse: Story = { parameters: { pathname: '/share/sample', api: { ...api, auth: authFixtures.loggedOut } } };
export const Trial: Story = { parameters: { pathname: '/try', api: { ...api, auth: authFixtures.loggedOut } } };
export const CourseMember: Story = {
  parameters: { pathname: '/videos/courses/42', api: { ...api, trpc: [...api.trpc.filter(mock => mock.path !== 'courses.get'), trpcQuery('courses.get', success({ ...course, access_role: 'member' }))] } },
};
