import type { Meta, StoryObj } from '@storybook/react-vite';
import { Route, Routes } from 'react-router-dom';
import { expect } from 'storybook/test';
import i18n from '@/i18n/config';
import VideoCourseDetailPage from './VideoCourseDetailPage';
import { authFixtures } from '../../.storybook/fixtures/auth';
import { course } from '../../.storybook/fixtures/detail';
import { success, trpcQuery } from '../../.storybook/mocks/network';

const meta = {
  title: 'Pages/Course management menu', component: VideoCourseDetailPage,
  render: () => <Routes><Route path="videos/courses/:id" element={<VideoCourseDetailPage />} /></Routes>,
  parameters: { pathname: '/videos/courses/42', api: { auth: authFixtures.user, trpc: [
    trpcQuery('courses.get', () => success(course)),
    trpcQuery('tags.list', () => success({ data: [], meta: { total: 0, limit: 100, offset: 0 } })),
    trpcQuery('chat.conversations', () => success({ items: [], hasMore: false })),
    trpcQuery('qa.list', () => success({ items: [], total: 0, canPost: true, canModerate: true })),
  ] } },
} satisfies Meta<typeof VideoCourseDetailPage>;
export default meta;
type Story = StoryObj<typeof meta>;
export const ManagementMenu: Story = {
  async play({ canvas, userEvent }) {
    await userEvent.click(await canvas.findByRole('button', { name: i18n.t('videos.courseDetail.manage') }));
    await expect(canvas.queryByRole('button', { name: /skills|スキル/i })).not.toBeInTheDocument();
  },
};
