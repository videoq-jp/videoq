import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, fn, waitFor, within } from 'storybook/test';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import i18n from '@/i18n/config';
import { Button } from '@/components/ui/button';
import { FeedbackProvider } from './FeedbackProvider';
import { useConfirm, useToast, type ConfirmOptions, type ToastOptions } from './feedback';

interface FeedbackExampleProps {
  mode: 'confirm' | 'toast';
  triggerLabel: string;
  confirmation: ConfirmOptions;
  notifications: ToastOptions[];
  onResult: (confirmed: boolean) => void;
}

function FeedbackControls({ mode, triggerLabel, confirmation, notifications, onResult }: FeedbackExampleProps) {
  const confirm = useConfirm();
  const toast = useToast();
  const { i18n } = useTranslation();
  const [result, setResult] = useState<boolean | null>(null);
  const english = i18n.language === 'en';

  const handleAction = async () => {
    if (mode === 'toast') {
      notifications.forEach(toast);
      return;
    }
    const confirmed = await confirm(confirmation);
    onResult(confirmed);
    setResult(confirmed);
  };

  return (
    <div className="space-y-4">
      <Button
        type="button"
        variant="outline"
        onClick={() => { void handleAction(); }}
      >
        {triggerLabel}
      </Button>
      {result !== null && (
        <p aria-live="polite">
          {result
            ? (english ? 'Confirmed' : '確定しました')
            : (english ? 'Cancelled' : 'キャンセルしました')}
        </p>
      )}
    </div>
  );
}

function FeedbackExample(args: FeedbackExampleProps) {
  return (
    <FeedbackProvider>
      <FeedbackControls {...args} />
    </FeedbackProvider>
  );
}

const meta = {
  title: 'Common/FeedbackProvider',
  component: FeedbackExample,
  parameters: {
    a11y: { test: 'error' },
    layout: 'padded',
    docs: { description: { component: 'Router内で実際のFeedbackProviderとuseConfirm/useToastを使います。Canvasではplayが対象状態を開き、ボタンで繰り返し操作できます。通常の通知はdurationMs: 0で固定し、自動消去はAutoDismissだけで検証します。Controls変更時はProviderを作り直し、前の確認・通知を持ち越しません。' } },
  },
  args: {
    mode: 'confirm',
    triggerLabel: '確認ダイアログを開く',
    confirmation: {
      title: '変更を保存しますか？',
      description: 'コース名と説明を更新します。',
      confirmLabel: '保存する',
      cancelLabel: 'キャンセル',
      variant: 'default',
    },
    notifications: [{ message: '変更を保存しました。', variant: 'success', durationMs: 0 }],
    onResult: fn(),
  },
  argTypes: { mode: { control: 'inline-radio', options: ['confirm', 'toast'] } },
  render: (args) => <FeedbackExample key={JSON.stringify([args.mode, args.confirmation, args.notifications])} {...args} />,
  play: async ({ canvas, userEvent, args }) => {
    await userEvent.click(canvas.getByRole('button', { name: args.triggerLabel }));
    if (args.mode === 'confirm') {
      const dialog = await canvas.findByRole('dialog', { name: args.confirmation.title });
      await expect(dialog).toBeVisible();
      await expect(within(dialog).getByRole('heading', { name: args.confirmation.title })).toHaveFocus();
      await expect(within(dialog).getByRole('button', {
        name: args.confirmation.confirmLabel ?? i18n.t('common.actions.confirm'),
      })).toBeVisible();
      await expect(within(dialog).getByRole('button', {
        name: args.confirmation.cancelLabel ?? i18n.t('common.actions.cancel'),
      })).toBeVisible();
    } else {
      for (const notification of args.notifications) {
        await expect(await canvas.findByText(notification.message)).toBeVisible();
      }
      await expect(canvas.getAllByRole('button', {
        name: i18n.t('common.actions.dismissNotification'),
      })).toHaveLength(args.notifications.length);
    }
  },
} satisfies Meta<typeof FeedbackExample>;
export default meta;
type Story = StoryObj<typeof meta>;

export const DefaultConfirmation: Story = {};
export const DangerConfirmation: Story = {
  args: {
    confirmation: {
      title: '動画を削除しますか？',
      description: '動画と文字起こしを削除します。この操作は取り消せません。',
      confirmLabel: '削除する',
      cancelLabel: 'キャンセル',
      variant: 'danger',
    },
  },
};
export const LongDescriptionMobile: Story = {
  args: {
    confirmation: {
      ...DangerConfirmation.args!.confirmation!,
      title: 'コースから選択した動画を削除しますか？',
      description: '「線形代数の基礎から学ぶ回転行列と座標変換」の動画をこのコースから削除します。参加者はコース内でこの動画を視聴できなくなります。関連する学習履歴への影響を確認してから操作を続けてください。',
    },
  },
  globals: { viewport: { value: 'mobile', isRotated: false } },
};
export const WithoutDescription: Story = {
  args: { confirmation: { title: '続行しますか？' } },
};
export const DefaultLabelsEnglishMobile: Story = {
  args: { triggerLabel: 'Open confirmation', confirmation: { title: 'Continue?' } },
  globals: { locale: 'en', viewport: { value: 'mobile', isRotated: false } },
  play: async (context) => {
    await meta.play(context);
    const { canvas, userEvent, args } = context;
    await i18n.changeLanguage('ja');
    try {
      const dialog = within(canvas.getByRole('dialog'));
      await expect(await dialog.findByRole('button', { name: '確認' })).toBeVisible();
      await userEvent.click(dialog.getByRole('button', { name: 'キャンセル' }));
      await expect(args.onResult).toHaveBeenCalledWith(false);
      await expect(canvas.queryByRole('dialog')).not.toBeInTheDocument();
      await expect(canvas.getByRole('button', { name: args.triggerLabel })).toHaveFocus();
    } finally {
      await i18n.changeLanguage('en');
    }
  },
};
export const ConfirmWithKeyboard: Story = {
  play: async (context) => {
    await meta.play(context);
    const { canvas, userEvent, args } = context;
    const dialog = within(canvas.getByRole('dialog'));
    await userEvent.tab();
    await expect(dialog.getByRole('button', { name: args.confirmation.cancelLabel })).toHaveFocus();
    await userEvent.tab();
    await expect(dialog.getByRole('button', { name: args.confirmation.confirmLabel })).toHaveFocus();
    await userEvent.keyboard('{Enter}');
    await expect(args.onResult).toHaveBeenCalledWith(true);
    await expect(canvas.queryByRole('dialog')).not.toBeInTheDocument();
    await expect(canvas.getByRole('button', { name: args.triggerLabel })).toHaveFocus();
  },
};
export const CancelConfirmation: Story = {
  args: { ...DangerConfirmation.args },
  play: async (context) => {
    await meta.play(context);
    const { canvas, userEvent, args } = context;
    await userEvent.click(within(canvas.getByRole('dialog')).getByRole('button', { name: args.confirmation.cancelLabel }));
    await expect(args.onResult).toHaveBeenCalledWith(false);
    await expect(canvas.queryByRole('dialog')).not.toBeInTheDocument();
    await expect(canvas.getByRole('button', { name: args.triggerLabel })).toHaveFocus();
  },
};
export const EnglishConfirmation: Story = {
  args: {
    triggerLabel: 'Open confirmation',
    confirmation: {
      title: 'Delete this video?',
      description: 'The video and its transcript will be deleted. This action cannot be undone.',
      confirmLabel: 'Delete',
      cancelLabel: 'Cancel',
      variant: 'danger',
    },
  },
  globals: { locale: 'en', viewport: { value: 'mobile', isRotated: false } },
};
export const SuccessToast: Story = { args: { mode: 'toast', triggerLabel: '通知を表示' } };
export const ErrorToast: Story = {
  args: { ...SuccessToast.args, notifications: [{ message: '変更を保存できませんでした。', variant: 'error', durationMs: 0 }] },
};
export const InfoToast: Story = {
  args: { ...SuccessToast.args, notifications: [{ message: 'リンクをクリップボードにコピーしました。', variant: 'info', durationMs: 0 }] },
};
export const MultipleToasts: Story = {
  args: {
    ...SuccessToast.args,
    notifications: [
      { message: 'コースを作成しました。', variant: 'success', durationMs: 0 },
      { message: '参加者に共有するための招待リンクをコピーしました。', variant: 'info', durationMs: 0 },
      { message: '動画の追加に失敗しました。通信状態を確認し、しばらく待ってからもう一度お試しください。', variant: 'error', durationMs: 0 },
    ],
  },
  globals: { viewport: { value: 'mobile', isRotated: false } },
};
export const DismissWithKeyboard: Story = {
  args: { ...MultipleToasts.args },
  play: async (context) => {
    await meta.play(context);
    const { canvas, userEvent } = context;
    const closeButtons = canvas.getAllByRole('button', { name: i18n.t('common.actions.dismissNotification') });
    await userEvent.tab();
    await expect(closeButtons[0]).toHaveFocus();
    await userEvent.keyboard('{Enter}');
    await expect(canvas.queryByText('コースを作成しました。')).not.toBeInTheDocument();
    await expect(canvas.getAllByRole('button', { name: i18n.t('common.actions.dismissNotification') })).toHaveLength(2);
    await userEvent.click(within(canvas.getByRole('alert')).getByRole('button', { name: i18n.t('common.actions.dismissNotification') }));
    await expect(canvas.queryByRole('alert')).not.toBeInTheDocument();
    await expect(canvas.getByRole('status')).toHaveTextContent('招待リンクをコピーしました');
  },
};
export const AutoDismiss: Story = {
  args: {
    ...SuccessToast.args,
    notifications: [{ message: '1秒後にこの通知を閉じます。', variant: 'info', durationMs: 1000 }],
  },
  parameters: { docs: { description: { story: '通知を表示した後、実際のタイマーで自動消去されるまで確認します。ボタンを押すと再表示できます。' } } },
  play: async (context) => {
    await meta.play(context);
    await waitFor(async () => {
      await expect(context.canvas.queryByText(context.args.notifications[0].message)).not.toBeInTheDocument();
    }, { timeout: 4000 });
  },
};
export const EnglishToastMobile: Story = {
  args: {
    mode: 'toast',
    triggerLabel: 'Show notification',
    notifications: [{ message: 'Your changes could not be saved. Check your connection and try again.', variant: 'error', durationMs: 0 }],
  },
  globals: { locale: 'en', viewport: { value: 'mobile', isRotated: false } },
};
