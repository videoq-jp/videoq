import type { Meta, StoryObj } from '@storybook/react-vite';
import { useState, type ComponentProps } from 'react';
import { expect, fn } from 'storybook/test';
import i18n from '@/i18n/config';
import { ChatComposer } from './ChatComposer';

function ComposerExample(args: ComponentProps<typeof ChatComposer>) {
  const [input, setInput] = useState(args.input);
  return (
    <div style={{ maxWidth: 720 }}>
      <ChatComposer
        {...args}
        input={input}
        onInputChange={(value) => { args.onInputChange(value); setInput(value); }}
      />
    </div>
  );
}

const meta = {
  title: 'Chat/ChatComposer',
  component: ChatComposer,
  args: {
    input: '',
    isLoading: false,
    onInputChange: fn(),
    onKeyDown: fn(),
    onSend: fn().mockResolvedValue(undefined),
  },
  // Local state works both in the manager and in portable browser tests.
  render: (args) => <ComposerExample key={args.input} {...args} />,
} satisfies Meta<typeof ChatComposer>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Empty: Story = {};
export const EnglishMobile: Story = {
  globals: { locale: 'en', viewport: { value: 'mobile', isRotated: false } },
};
export const JapaneseMobile: Story = {
  play: async ({ canvas }) => {
    const send = canvas.getByRole('button', { name: i18n.t('common.actions.send') });
    await expect(send.getBoundingClientRect().width).toBeGreaterThanOrEqual(44);
    await expect(send.getBoundingClientRect().height).toBeGreaterThanOrEqual(44);
  },
  globals: { locale: 'ja', viewport: { value: 'mobile', isRotated: false } },
};
export const ReadyToSend: Story = { args: { input: '回転行列の定義を教えてください。' } };
export const WhitespaceOnly: Story = { args: { input: '   ' } };
export const LongInput: Story = { args: { input: '講義で説明されていた回転行列と座標変換の関係について、具体的な計算例を用いながら説明してください。'.repeat(3) } };
export const Sending: Story = { args: { input: '回転行列の定義を教えてください。', isLoading: true } };
export const TypeAndSend: Story = {
  play: async ({ canvas, userEvent, args }) => {
    const input = canvas.getByRole('textbox');
    const send = canvas.getByRole('button', { name: i18n.t('common.actions.send') });
    await expect(send).toBeDisabled();
    await userEvent.type(input, '回転行列について');
    await expect(input).toHaveValue('回転行列について');
    await expect(send).toBeEnabled();
    await userEvent.click(send);
    await expect(args.onSend).toHaveBeenCalledTimes(1);
  },
};
