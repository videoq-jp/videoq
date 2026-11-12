import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, fn } from 'storybook/test';
import i18n from '@/i18n/config';
import { ChatMessageBubble } from './ChatMessageBubble';
import { answerData, citations, interrupted, longAnswerData, mathAnswerData, searching } from '../../../.storybook/fixtures/chat';

const meta = {
  title: 'Chat/ChatMessageBubble',
  component: ChatMessageBubble,
  decorators: [(Story) => <div style={{ maxWidth: 800 }}><Story /></div>],
  args: {
    message: { role: 'assistant', answer: { segments: [{ text: '講義動画の内容を一緒に確認しましょう。', sourceIds: [] }], sources: [] } },
    isFeedbackUpdating: false,
    onVideoNavigate: fn(),
    onFeedback: fn().mockResolvedValue(undefined),
  },
} satisfies Meta<typeof ChatMessageBubble>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Assistant: Story = {};
export const User: Story = { args: { message: { role: 'user', content: '回転行列について、具体例を使って教えてください。' } } };
export const AwaitingResponse: Story = { args: { message: { role: 'assistant', answer: { segments: [{ text: '', sourceIds: [] }], sources: [] } }, isAwaitingResponse: true } };
export const Searching: Story = { args: { message: { role: 'assistant', answer: { segments: [{ text: '', sourceIds: [] }], sources: [] }, progress: searching }, isAwaitingResponse: true } };
export const Streaming: Story = { args: { message: { role: 'assistant', answer: { segments: [{ text: '回転行列は、ベクトルの長さを変えずに', sourceIds: [] }], sources: [] }, progress: { ...searching, phase: 'answering' } }, isAwaitingResponse: true } };
export const Interrupted: Story = { args: { message: { role: 'assistant', answer: { segments: [{ text: '応答が中断されました。もう一度お試しください。', sourceIds: [] }], sources: [] }, progress: interrupted } } };
export const WithCitations: Story = { args: { message: { role: 'assistant', answer: answerData } } };
export const WithMath: Story = { args: { message: { role: 'assistant', answer: mathAnswerData } } };
export const LongText: Story = { args: { message: { role: 'assistant', answer: longAnswerData } } };
export const Feedback: Story = {
  args: { message: { role: 'assistant', answer: answerData, chatLogId: 42 } },
  play: async ({ canvas, userEvent, args }) => {
    const good = canvas.getByRole('button', { name: i18n.t('chat.feedbackGood') });
    await expect(good.getBoundingClientRect().width).toBeGreaterThanOrEqual(44);
    await expect(good.getBoundingClientRect().height).toBeGreaterThanOrEqual(44);
    await userEvent.click(good);
    await expect(args.onFeedback).toHaveBeenCalledWith(42, 'good');
    await userEvent.click(canvas.getByRole('button', { name: i18n.t('chat.feedbackBad') }));
    await expect(args.onFeedback).toHaveBeenCalledWith(42, 'bad');
  },
};
export const GoodFeedback: Story = { args: { message: { role: 'assistant', answer: answerData, chatLogId: 42, feedback: 'good' } } };
export const BadFeedback: Story = { args: { message: { role: 'assistant', answer: answerData, chatLogId: 42, feedback: 'bad' } } };
export const FeedbackUpdating: Story = {
  args: { message: { role: 'assistant', answer: answerData, chatLogId: 42 }, isFeedbackUpdating: true },
  play: async ({ canvas }) => {
    await expect(canvas.getByRole('button', { name: i18n.t('chat.feedbackGood') })).toBeDisabled();
    await expect(canvas.getByRole('button', { name: i18n.t('chat.feedbackBad') })).toBeDisabled();
  },
};
export const EnglishMobile: Story = {
  args: { message: { role: 'assistant', answer: { segments: [{ text: "A rotation matrix changes the direction of a vector without changing its length. ", sourceIds: [1] }], sources: citations }, chatLogId: 42 } },
  globals: { locale: 'en', viewport: { value: 'mobile', isRotated: false } },
};
