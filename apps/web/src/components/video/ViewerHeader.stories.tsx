import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, within } from 'storybook/test';
import { ViewerHeader } from './ViewerHeader';
import { ViewerActionsMenu } from './ViewerActionsMenu';
import { Button } from '@/components/ui/button';

const meta = {
  title: 'Video/ViewerHeader',
  component: ViewerHeader,
  parameters: { layout: 'fullscreen', a11y: { test: 'error' } },
  args: { title: '【藤吉】ロボットビジョン' },
} satisfies Meta<typeof ViewerHeader>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};
export const WithActions: Story = {
  args: { children: <ViewerActionsMenu label="講座の管理"><Button variant="text">共有設定</Button></ViewerActionsMenu> },
};
export const LongTitleMobile: Story = {
  ...WithActions,
  globals: { viewport: { value: 'mobile', isRotated: false } },
  args: { ...WithActions.args, title: 'ロボットビジョン：画像の標本化・量子化と画像処理の基礎を学ぶ講義' },
};
export const EnglishMobile: Story = {
  globals: { locale: 'en', viewport: { value: 'mobile', isRotated: false } },
  args: { title: 'Robot vision: sampling and quantization' },
};
export const KeyboardMenu: Story = {
  ...WithActions,
  async play({ canvasElement, userEvent }) {
    const canvas = within(canvasElement);
    const trigger = canvas.getByRole('button', { name: '講座の管理' });
    await userEvent.tab();
    await expect(canvas.getByRole('link', { name: 'VideoQ' })).toHaveFocus();
    await userEvent.tab();
    await expect(trigger).toHaveFocus();
    await userEvent.keyboard('{ArrowDown}');
    await expect(canvas.getByRole('button', { name: '共有設定' })).toHaveFocus();
    await userEvent.keyboard('{Escape}');
    await expect(trigger).toHaveFocus();
    await expect(trigger).toHaveAttribute('aria-expanded', 'false');
  },
};
