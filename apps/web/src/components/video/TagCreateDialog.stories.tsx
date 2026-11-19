import { useState, type ComponentProps } from 'react';
import { useTranslation } from 'react-i18next';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, fn, mocked, waitFor, within } from 'storybook/test';
import i18n from '@/i18n/config';
import { Button } from '@/components/ui/button';
import { DEFAULT_TAG_CHIP_COLOR, TAG_CHIP_COLORS } from '@/lib/tagColors';
import { englishTags, longTag, tags } from '../../../.storybook/fixtures/tags';
import { createTagError } from '../../../.storybook/fixtures/createDialogs';
import { TagCreateDialog } from './TagCreateDialog';

function TagCreateExample({ isOpen, onClose, onCreate }: ComponentProps<typeof TagCreateDialog>) {
  const [open, setOpen] = useState(isOpen);
  const { t } = useTranslation();
  return (
    <>
      <Button variant="outline" onClick={() => setOpen(true)}>{t('tags.create.title')}</Button>
      <TagCreateDialog isOpen={open} onCreate={onCreate} onClose={() => { onClose(); setOpen(false); }} />
    </>
  );
}

const meta = {
  title: 'Video/TagCreateDialog',
  component: TagCreateExample,
  subcomponents: { TagCreateDialog },
  args: { isOpen: false, onClose: fn(), onCreate: fn().mockResolvedValue(undefined) },
  render: args => <TagCreateExample key={String(args.isOpen)} {...args} />,
  parameters: {
    docs: { description: { component: '実際のダイアログをボタンで開きます。作成はモックの成功・保留・失敗を使い、APIに接続しません。Creatingは保留状態を維持するため、ストーリーの再実行で初期化してください。失敗時は共通エラーバナーを表示し、入力を保持して再試行できます。' } },
  },
  play: async ({ canvas, userEvent }) => {
    if (!canvas.queryByRole('dialog')) {
      await userEvent.click(canvas.getByRole('button', { name: i18n.t('tags.create.title') }));
    }
    const dialog = within(await canvas.findByRole('dialog', { name: i18n.t('tags.create.title') }));
    await expect(dialog.getByRole('heading')).toHaveFocus();
  },
} satisfies Meta<typeof TagCreateExample>;
export default meta;
type Story = StoryObj<typeof meta>;
type PlayContext = Parameters<NonNullable<Story['play']>>[0];

const colorLabel = (color: string) => i18n.t('tags.create.selectColor', { color, defaultValue: `Select color ${color}` });

async function fillName(context: PlayContext, name = tags[0].name) {
  await meta.play(context);
  const dialog = within(context.canvas.getByRole('dialog'));
  await context.userEvent.type(dialog.getByRole('textbox', { name: i18n.t('tags.create.nameLabel') }), name);
  return dialog;
}

export const Initial: Story = {
  play: async context => {
    await meta.play(context);
    const dialog = within(context.canvas.getByRole('dialog'));
    await expect(dialog.getByRole('textbox', { name: i18n.t('tags.create.nameLabel') })).toHaveValue('');
    await expect(dialog.getByRole('button', { name: colorLabel(DEFAULT_TAG_CHIP_COLOR) })).toHaveAttribute('aria-pressed', 'true');
    await expect(dialog.getByRole('button', { name: i18n.t('common.actions.create') })).toBeDisabled();
    await expect(dialog.getByText(i18n.t('tags.create.previewPlaceholder'))).toBeVisible();
  },
};
export const NameAndColorPreview: Story = {
  play: async context => {
    const dialog = await fillName(context);
    await context.userEvent.click(dialog.getByRole('button', { name: colorLabel('green') }));
    await expect(dialog.getByText(tags[0].name)).toHaveAttribute('data-color', 'green');
    await expect(dialog.getByRole('button', { name: colorLabel('green') })).toHaveAttribute('aria-pressed', 'true');
    await expect(dialog.getByRole('button', { name: colorLabel(DEFAULT_TAG_CHIP_COLOR) })).toHaveAttribute('aria-pressed', 'false');
  },
};
export const MaxLengthMobile: Story = {
  globals: { locale: 'ja', viewport: { value: 'mobile', isRotated: false } },
  play: async context => {
    const name = longTag.name.repeat(2).slice(0, 50);
    const dialog = await fillName(context, `${name}追加できない文字`);
    await expect(dialog.getByRole('textbox', { name: i18n.t('tags.create.nameLabel') })).toHaveValue(name);
    await expect(dialog.getByText(name)).toBeVisible();
  },
};
export const WhitespaceName: Story = {
  play: async context => {
    const dialog = await fillName(context, '   ');
    await expect(dialog.getByRole('button', { name: i18n.t('common.actions.create') })).toBeDisabled();
    await expect(context.args.onCreate).not.toHaveBeenCalled();
  },
};
export const KeyboardCreate: Story = {
  play: async context => {
    await meta.play(context);
    const { canvas, userEvent, args } = context;
    const dialog = within(canvas.getByRole('dialog'));
    await userEvent.tab();
    await expect(dialog.getByRole('textbox', { name: i18n.t('tags.create.nameLabel') })).toHaveFocus();
    await userEvent.keyboard(`  ${tags[0].name}  `);
    for (const color of TAG_CHIP_COLORS) {
      await userEvent.tab();
      await expect(dialog.getByRole('button', { name: colorLabel(color) })).toHaveFocus();
      if (color === 'green') await userEvent.keyboard(' ');
    }
    await userEvent.tab();
    await expect(dialog.getByRole('button', { name: i18n.t('common.actions.cancel') })).toHaveFocus();
    await userEvent.tab();
    await expect(dialog.getByRole('button', { name: i18n.t('common.actions.create') })).toHaveFocus();
    await userEvent.keyboard('{Enter}');
    await expect(args.onCreate).toHaveBeenCalledWith(tags[0].name, 'green');
    await waitFor(() => expect(canvas.queryByRole('dialog')).not.toBeInTheDocument());
    await expect(args.onClose).toHaveBeenCalledTimes(1);
    await expect(canvas.getByRole('button', { name: i18n.t('tags.create.title') })).toHaveFocus();
  },
};
export const Creating: Story = {
  args: { onCreate: fn(() => new Promise<void>(() => {})) },
  play: async context => {
    const dialog = await fillName(context);
    await context.userEvent.click(dialog.getByRole('button', { name: i18n.t('common.actions.create') }));
    await expect(await dialog.findByRole('button', { name: i18n.t('common.actions.creating') })).toBeDisabled();
    await expect(dialog.getByRole('textbox')).toBeDisabled();
    for (const button of dialog.getAllByRole('button')) await expect(button).toBeDisabled();
    for (const color of TAG_CHIP_COLORS) {
      const button = dialog.getByRole('button', { name: colorLabel(color) });
      await expect(getComputedStyle(button).opacity).toBe('1');
      await expect(getComputedStyle(button.firstElementChild!).color).toBe('rgb(148, 148, 148)');
    }
    context.canvas.getByRole('dialog').dispatchEvent(new Event('cancel', { cancelable: true }));
    await expect(context.canvas.getByRole('dialog')).toBeVisible();
    await expect(context.args.onClose).not.toHaveBeenCalled();
    await expect(context.args.onCreate).toHaveBeenCalledTimes(1);
  },
};
export const FailureThenRetry: Story = {
  args: { onCreate: fn() },
  beforeEach: ({ args }) => {
    mocked(args.onCreate).mockRejectedValueOnce(new Error(createTagError)).mockResolvedValue(undefined);
  },
  play: async context => {
    const dialog = await fillName(context);
    await context.userEvent.click(dialog.getByRole('button', { name: colorLabel('green') }));
    const create = dialog.getByRole('button', { name: i18n.t('common.actions.create') });
    await context.userEvent.click(create);
    await waitFor(() => expect(create).toBeEnabled());
    await expect(context.args.onCreate).toHaveBeenCalledTimes(1);
    await expect(dialog.getByRole('alert')).toHaveTextContent(i18n.t('tags.create.failed'));
    await expect(context.args.onClose).not.toHaveBeenCalled();
    await expect(dialog.getByRole('textbox')).toHaveValue(tags[0].name);
    await expect(dialog.getByRole('button', { name: colorLabel('green') })).toHaveAttribute('aria-pressed', 'true');
    await expect(context.args.onCreate).toHaveBeenLastCalledWith(tags[0].name, 'green');
    await context.userEvent.click(create);
    await waitFor(() => expect(context.canvas.queryByRole('dialog')).not.toBeInTheDocument());
    await expect(context.args.onCreate).toHaveBeenCalledTimes(2);
    await expect(context.args.onClose).toHaveBeenCalledTimes(1);
  },
};
export const CancelAndReopen: Story = {
  play: async context => {
    const dialog = await fillName(context);
    await context.userEvent.click(dialog.getByRole('button', { name: colorLabel('purple') }));
    await context.userEvent.click(dialog.getByRole('button', { name: i18n.t('common.actions.cancel') }));
    await expect(context.canvas.queryByRole('dialog')).not.toBeInTheDocument();
    await expect(context.args.onCreate).not.toHaveBeenCalled();
    await expect(context.args.onClose).toHaveBeenCalledTimes(1);
    await meta.play(context);
    const reopened = within(context.canvas.getByRole('dialog'));
    await expect(reopened.getByRole('textbox')).toHaveValue('');
    await expect(reopened.getByRole('button', { name: colorLabel(DEFAULT_TAG_CHIP_COLOR) })).toHaveAttribute('aria-pressed', 'true');
  },
};
export const EscapeRequest: Story = {
  parameters: { docs: { description: { story: 'playではネイティブdialogのcancelイベントで閉じる要求を検証します。Canvasで実際のEscapeキーも操作できます。' } } },
  play: async context => {
    await fillName(context);
    context.canvas.getByRole('dialog').dispatchEvent(new Event('cancel', { cancelable: true }));
    await waitFor(() => expect(context.canvas.queryByRole('dialog')).not.toBeInTheDocument());
    await expect(context.args.onClose).toHaveBeenCalledTimes(1);
    await expect(context.args.onCreate).not.toHaveBeenCalled();
  },
};
export const EnglishMobile: Story = {
  globals: { locale: 'en', viewport: { value: 'mobile', isRotated: false } },
  play: async context => {
    const dialog = await fillName(context, englishTags[0].name);
    await context.userEvent.click(dialog.getByRole('button', { name: colorLabel('orange') }));
  },
};

export const FailureThenRetryEnglishMobile: Story = { ...FailureThenRetry, globals: { locale: 'en', viewport: { value: 'mobile', isRotated: false } } };

export const Failure: Story = {
  args: { onCreate: fn() },
  beforeEach: ({ args }) => { mocked(args.onCreate).mockRejectedValue(new Error(createTagError)); },
  async play(context) {
    const dialog = await fillName(context);
    await context.userEvent.click(dialog.getByRole('button', { name: i18n.t('common.actions.create') }));
    await expect(await dialog.findByRole('alert')).toHaveTextContent(i18n.t('tags.create.failed'));
    await expect(dialog.getByRole('textbox')).toHaveValue(tags[0].name);
    await expect(dialog.getByRole('button', { name: i18n.t('common.actions.create') })).toBeEnabled();
  },
};
export const FailureMobile: Story = { ...Failure, globals: { locale: 'ja', viewport: { value: 'mobile', isRotated: false } } };
