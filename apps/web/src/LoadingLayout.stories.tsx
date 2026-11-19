import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, waitFor } from 'storybook/test';
import { SharedCourseView } from '@/pages/SharePage';
import { Button } from '@/components/ui/button';
import { appQueryClient } from '@/lib/queryClient';
import { trpc } from '@/lib/trpc';
import { course } from '../.storybook/fixtures/detail';
import { authFixtures } from '../.storybook/fixtures/auth';
import { pending, trpcQuery } from '../.storybook/mocks/network';

const slug = 'layout-review';
const data = { ...course, updated_at: course.created_at, share_slug: slug, access_role: 'public' as const };
function receiveData() {
  appQueryClient.setQueryData(trpc.courses.shared.queryKey({ slug }), data);
}
const meta = {
  title: 'Review/Stable loading layout', component: SharedCourseView,
  args: { shareToken: slug },
  render: args => <SharedCourseView {...args} headerAction={<Button size="sm" onClick={receiveData}>Receive data</Button>} />,
  parameters: { layout: 'fullscreen', api: { auth: authFixtures.loggedOut, trpc: [trpcQuery('courses.shared', pending())] } },
} satisfies Meta<typeof SharedCourseView>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Loading: Story = {
  async play({ canvas, canvasElement }) {
    await expect(canvas.getByRole('textbox')).toBeDisabled();
    const player = canvasElement.querySelector('[data-player-loading]')!;
    await expect(player.getBoundingClientRect().height).toBeGreaterThan(100);
    await expect(canvasElement.scrollWidth).toBeLessThanOrEqual(canvasElement.clientWidth);
  },
};
export const LoadingMobile: Story = { ...Loading, globals: { viewport: { value: 'mobile', isRotated: false } } };
export const LoadingEnglishMobile: Story = { ...Loading, globals: { locale: 'en', viewport: { value: 'mobile', isRotated: false } } };
export const ReceiveData: Story = {
  async play({ canvas, canvasElement, userEvent }) {
    const main = () => canvasElement.querySelector('main')!.getBoundingClientRect();
    const aside = () => canvasElement.querySelector('main > aside')!.getBoundingClientRect();
    const composer = () => canvas.getByRole('textbox').getBoundingClientRect();
    const playerBefore = canvasElement.querySelector('[data-player-loading]')!.getBoundingClientRect();
    const before = [main(), aside(), composer()];
    await userEvent.click(canvas.getByRole('button', { name: 'Receive data' }));
    await waitFor(() => expect(canvas.getByRole('textbox')).toBeEnabled());
    const after = [main(), aside(), composer()];
    for (let index = 0; index < before.length; index++) {
      for (const dimension of ['x', 'y', 'width', 'height'] as const) {
        await expect(Math.abs(before[index][dimension] - after[index][dimension])).toBeLessThan(1);
      }
    }
    const playerAfter = canvasElement.querySelector('main > section .aspect-video')!.getBoundingClientRect();
    for (const dimension of ['x', 'y', 'width', 'height'] as const) {
      await expect(Math.abs(playerBefore[dimension] - playerAfter[dimension])).toBeLessThan(1);
    }
  },
};
export const ReceiveDataMobile: Story = { ...ReceiveData, globals: { viewport: { value: 'mobile', isRotated: false } } };
export const ReceiveDataEnglishMobile: Story = { ...ReceiveData, globals: { locale: 'en', viewport: { value: 'mobile', isRotated: false } } };
