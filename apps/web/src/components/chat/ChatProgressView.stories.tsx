import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect } from 'storybook/test';
import { ChatProgressView } from './ChatProgressView';
import { interrupted, searched, searching } from '../../../.storybook/fixtures/chat';

const meta = {
  title: 'Chat/ChatProgressView',
  component: ChatProgressView,
  decorators: [(Story) => <div style={{ maxWidth: 640 }}><Story /></div>],
  args: { progress: { phase: 'preparing', searches: [] }, waitingForAnswer: true },
} satisfies Meta<typeof ChatProgressView>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Preparing: Story = {};
export const Thinking: Story = { args: { progress: { phase: 'thinking', searches: [] } } };
export const Summarizing: Story = { args: { progress: { phase: 'summarizing', searches: [] } } };
export const Reviewing: Story = { args: { progress: { ...searched, phase: 'reviewing' } } };
export const ReviewingAfterTools: Story = { args: { progress: {
  phase: 'reviewing', searches: [], tools: [{ id: 1, tool: 'search_scenes', status: 'complete' }],
} } };
export const SummarizingAfterTools: Story = { args: { progress: {
  phase: 'summarizing', searches: [], tools: [{ id: 1, tool: 'search_scenes', status: 'complete' }],
} } };
export const Answering: Story = { args: { progress: { ...searched, phase: 'answering' } } };
export const Searching: Story = { args: { progress: searching } };
export const InspectingVideo: Story = {
  args: { progress: { phase: 'searching', searches: [], tools: [
    { id: 1, tool: 'get_course_info', status: 'complete' },
    { id: 2, tool: 'overview_video', status: 'complete' },
    { id: 3, tool: 'focus_clip', status: 'running' },
  ] }, waitingForAnswer: true },
};
export const Completed: Story = { args: { progress: searched, waitingForAnswer: false } };
export const Interrupted: Story = { args: { progress: interrupted, waitingForAnswer: false } };
export const WaitingForFirstText: Story = { args: { progress: searched, waitingForAnswer: true } };
export const NoSearchHistory: Story = {
  args: { progress: { phase: 'complete', searches: [] }, waitingForAnswer: false },
  parameters: { docs: { description: { story: '検索履歴がなく回答待ちでもない場合、進捗UIは表示されません。' } } },
};
export const Expanded: Story = {
  args: { progress: searched, waitingForAnswer: false },
  play: async ({ canvas, userEvent }) => {
    const toggle = canvas.getByRole('button');
    toggle.focus();
    await userEvent.keyboard('{Enter}');
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');
    await expect(canvas.getByRole('list')).toBeVisible();
    await userEvent.keyboard('{Enter}');
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await userEvent.click(toggle);
  },
};
export const LongQuery: Story = {
  args: {
    progress: {
      phase: 'searching',
      searches: [{ id: 1, status: 'running', query: '回転行列における座標変換と固有値の関係について、講義中に紹介されていた具体例をすべて挙げながら詳しく説明してください。'.repeat(3) }],
    },
  },
  play: async ({ canvas, userEvent }) => { await userEvent.click(canvas.getByRole('button')); },
};
export const EnglishMobile: Story = {
  args: { progress: searching },
  globals: { locale: 'en', viewport: { value: 'mobile', isRotated: false } },
};
