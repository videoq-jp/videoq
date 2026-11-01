import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, fn, within } from 'storybook/test';
import { Button } from '@/components/ui/button';
import { AppPageHeader } from './AppPageHeader';

const onCreate = fn();
const meta = {
  title: 'Layout/AppPageHeader',
  component: AppPageHeader,
  args: { title: '動画ライブラリ', description: '講義動画を追加して、タグや講座ごとに整理できます。' },
  decorators: [(Story) => <div className="mx-auto max-w-screen-xl p-4"><Story /></div>],
  async play({ canvasElement, args }) {
    if (typeof args.title !== 'string') throw new Error('This story expects a text title');
    await expect(within(canvasElement).getByRole('heading', { level: 1 })).toHaveTextContent(args.title);
  },
} satisfies Meta<typeof AppPageHeader>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};
export const TitleOnly: Story = { args: { description: undefined } };
export const WithBadge: Story = { args: { badge: '教材管理' } };
export const WithAction: Story = { args: { action: <Button onClick={onCreate}>動画を追加</Button> } };
export const AllElements: Story = { args: { ...WithAction.args, badge: '教材管理' } };
export const LongContent: Story = { args: {
  ...AllElements.args,
  title: '線形代数の講義・演習・復習用動画をまとめて管理する共同学習ワークスペース',
  description: '学期を通して使用する講義動画や補足資料を登録し、タグ・講座・公開範囲を整理します。共同担当者と共有する教材の更新状況もここで確認できます。',
} };
export const LongContentMobile: Story = { ...LongContent, globals: { viewport: { value: 'mobile', isRotated: false } } };
export const EnglishMobile: Story = {
  globals: { locale: 'en', viewport: { value: 'mobile', isRotated: false } },
  args: { title: 'Course materials and lecture recordings', description: 'Organize recordings, exercises, and shared learning resources for the entire semester.', badge: 'Workspace', action: <Button onClick={onCreate}>Add video</Button> },
};
export const KeyboardAction: Story = {
  args: AllElements.args,
  async play({ canvasElement, userEvent }) {
    const button = within(canvasElement).getByRole('button', { name: '動画を追加' });
    await userEvent.tab();
    await expect(button).toHaveFocus();
    await userEvent.keyboard('{Enter}');
    await expect(onCreate).toHaveBeenCalledTimes(1);
  },
};
