import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, waitFor } from 'storybook/test';
import i18n from '@/i18n/config';
import VideoCoursesPage from './VideoCoursesPage';
import { authFixtures } from '../../.storybook/fixtures/auth';
import { course } from '../../.storybook/fixtures/detail';
import { success, trpcQuery, trpcMutation } from '../../.storybook/mocks/network';

const fixture = [{ ...course, access_role: 'owner' as const, id: 42, name: '線形代数入門' }, { ...course, access_role: 'owner' as const, id: 43, name: '微分積分入門', display_order: 1 }];
let courses = [...fixture];
const meta = {
  title: 'Pages/Course ordering', component: VideoCoursesPage,
  parameters: { pathname: '/videos/courses', api: { auth: authFixtures.user, trpc: [
    trpcQuery('courses.list', () => success({ data: courses, meta: { total: courses.length, limit: 24, offset: 0 } })),
    trpcMutation('courses.reorder', ({ courseIds }) => {
      courses = courseIds.map(id => courses.find(course => course.id === id)!);
      return success({ courseIds });
    }),
  ] }, a11y: { test: 'error' } },
  beforeEach() { courses = [...fixture]; },
} satisfies Meta<typeof VideoCoursesPage>;
export default meta;
type Story = StoryObj<typeof meta>;
export const KeyboardReorder: Story = {
  async play({ canvas, userEvent }) {
    const handles = await canvas.findAllByRole('button', { name: i18n.t('videos.courses.dragHandle') });
    await expect(handles).toHaveLength(2);
    await expect(handles[0].getBoundingClientRect().width).toBeGreaterThanOrEqual(44);
    await expect(handles[0].getBoundingClientRect().height).toBeGreaterThanOrEqual(44);
    handles[0].focus();
    await userEvent.keyboard('{Tab}{Shift>}{Tab}{/Shift}');
    await expect(getComputedStyle(handles[0]).outline).toBe('rgb(0, 0, 0) solid 4px');
    await userEvent.keyboard(' {ArrowDown} ');
    await waitFor(() => expect(canvas.getAllByRole('button', { name: i18n.t('videos.courses.dragHandle') })[1]).toBe(handles[0]));
    await waitFor(() => expect(handles[0]).toHaveAttribute('aria-disabled', 'false'));
    await expect(handles[0]).toHaveFocus();
  },
};
export const Preview: Story = {};
export const Mobile: Story = { ...KeyboardReorder, globals: { locale: 'ja', viewport: { value: 'mobile', isRotated: false } } };
export const EnglishMobile: Story = { ...KeyboardReorder, globals: { locale: 'en', viewport: { value: 'mobile', isRotated: false } } };
