import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, fn } from 'storybook/test';
import { CourseQaPanel } from './CourseQaPanel';
import { authFixtures } from '../../../../.storybook/fixtures/auth';
import { failure, pending, trpcQuery } from '../../../../.storybook/mocks/network';

const meta = {
  title: 'Video/Course QA', component: CourseQaPanel,
  args: { courseId: 42, active: true, onVideoPlay: fn() },
  parameters: { api: { auth: authFixtures.user, trpc: [trpcQuery('qa.list', failure())] }, a11y: { test: 'error' } },
  decorators: [(Story) => <div className="mx-auto max-w-xl p-4"><Story /></div>],
} satisfies Meta<typeof CourseQaPanel>;
export default meta;
type Story = StoryObj<typeof meta>;
export const LoadError: Story = { async play({ canvas }) {
  await expect(await canvas.findByRole('alert')).toHaveAttribute('data-type', 'error');
} };
export const Loading: Story = {
  parameters: { api: { trpc: [trpcQuery('qa.list', pending())] } },
  async play({ canvas }) { await expect(await canvas.findByRole('progressbar')).toBeVisible(); },
};
export const ErrorEnglishMobile: Story = { ...LoadError, globals: { locale: 'en', viewport: { value: 'mobile', isRotated: false } } };
