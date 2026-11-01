import { useState, type ComponentProps } from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, fn, waitFor, within } from 'storybook/test';
import i18n from '@/i18n/config';
import { Button } from '@/components/ui/button';
import { authFixtures } from '../../../.storybook/fixtures/auth';
import { tags, englishTags, manyTags } from '../../../.storybook/fixtures/tags';
import { failure, pending, success, trpcHandler, trpcMutation, trpcQuery } from '../../../.storybook/mocks/network';
import { installUploadFixture, uploadError, uploadRequest, type UploadScenario } from '../../../.storybook/mocks/videoUpload';
import { VideoUploadModal } from './VideoUploadModal';

interface ModalScenario extends UploadScenario { tags?: typeof tags; tagResult?: 'pending' | 'retry' }
const createTagRequest = fn();
const fileName = '線形代数の講義.mp4';
const youtubeUrl = 'https://www.youtube.com/watch?v=storybook01';
const createTagName = '演習資料';

function UploadExample(args: ComponentProps<typeof VideoUploadModal>) {
  const [open, setOpen] = useState(args.isOpen);
  return <>
    <Button onClick={() => setOpen(true)}>{i18n.t('videos.upload.title')}</Button>
    <VideoUploadModal {...args} isOpen={open} onClose={() => { args.onClose(); setOpen(false); }} />
  </>;
}
const meta = {
  title: 'Video/VideoUploadModal',
  component: VideoUploadModal,
  args: { isOpen: false, onClose: fn(), autoCloseDelayMs: null },
  render: args => <UploadExample key={String(args.isOpen)} {...args} />,
  parameters: { api: { auth: authFixtures.user }, docs: { story: { inline: false, height: '1000px' } } },
  beforeEach({ parameters, msw }) {
    const scenario: ModalScenario = parameters.uploadModal ?? {};
    const cleanup = installUploadFixture(scenario);
    let rows = structuredClone(scenario.tags ?? tags);
    let attempts = 0;
    createTagRequest.mockClear();
    msw.use(trpcHandler([
      trpcQuery('tags.list', () => success({ data: rows, meta: { total: rows.length, limit: 100, offset: 0 } })),
      trpcMutation('tags.create', input => {
        createTagRequest(input); attempts++;
        if (scenario.tagResult === 'pending') return pending();
        if (scenario.tagResult === 'retry' && attempts === 1) return failure('タグを作成できませんでした / Failed to create tag');
        const tag = { id: 500 + attempts, ...input, color: input.color ?? 'blue', created_at: '2026-09-01T00:00:00Z', video_count: 0 };
        rows = [...rows, tag];
        return success(tag);
      }),
    ]));
    return cleanup;
  },
  async play({ canvas, userEvent }) {
    if (!canvas.queryByRole('dialog')) await userEvent.click(canvas.getByRole('button', { name: i18n.t('videos.upload.title') }));
    const dialog = within(await canvas.findByRole('dialog', { name: i18n.t('videos.upload.title') }));
    await expect(dialog.getByRole('heading')).toHaveFocus();
    await dialog.findByRole('button', { name: (i18n.language === 'en' ? /線形代数|Linear algebra/ : '線形代数') });
  },
} satisfies Meta<typeof VideoUploadModal>;
export default meta;
type Story = StoryObj<typeof meta>;
type Context = Parameters<NonNullable<Story['play']>>[0];

async function fillFile(context: Context) {
  await meta.play(context);
  const dialog = within(context.canvas.getByRole('dialog'));
  const input = dialog.getByLabelText<HTMLInputElement>(i18n.t('videos.upload.fileLabel'), { exact: false, selector: 'input[type="file"]' });
  // userEvent.upload only shadows files; Chromium's native `required` validation
  // still sees an empty FileList. Assign the browser's FileList before change.
  const transfer = new DataTransfer();
  transfer.items.add(new File(['storybook upload fixture'], fileName, { type: 'video/mp4' }));
  input.files = transfer.files;
  input.dispatchEvent(new Event('change', { bubbles: true }));
  await waitFor(() => expect(dialog.getByLabelText(i18n.t('videos.upload.titleLabel'), { exact: false })).toHaveValue('線形代数の講義'));
  await context.userEvent.type(dialog.getByLabelText(i18n.t('videos.upload.descriptionLabel'), { exact: false }), '第1回の講義と演習');
  return dialog;
}
async function fillYoutube(context: Context) {
  await meta.play(context);
  const dialog = within(context.canvas.getByRole('dialog'));
  await context.userEvent.click(dialog.getByRole('button', { name: i18n.t('videos.upload.modes.youtube') }));
  await context.userEvent.type(dialog.getByLabelText(i18n.t('videos.upload.youtubeUrlLabel'), { exact: false }), youtubeUrl);
  await context.userEvent.type(dialog.getByLabelText(i18n.t('videos.upload.titleLabel'), { exact: false }), 'Introduction to linear algebra');
  return dialog;
}
async function openTagCreate(context: Context) {
  const dialog = await fillFile(context);
  await context.userEvent.click(dialog.getByRole('button', { name: `+ ${i18n.t('tags.selector.createNew')}` }));
  const create = within(context.canvas.getByRole('dialog', { name: i18n.t('tags.create.title') }));
  await context.userEvent.type(create.getByLabelText(i18n.t('tags.create.nameLabel'), { exact: false }), createTagName);
  return create;
}
async function assertBusy(context: Context) {
  const element = context.canvas.getByRole('dialog');
  const dialog = within(element);
  await waitFor(() => expect(dialog.getByRole('button', { name: i18n.t('common.actions.cancel') })).toBeDisabled());
  for (const button of dialog.getAllByRole('button')) await expect(button).toBeDisabled();
  for (const input of element.querySelectorAll('input, textarea')) await expect(input).toBeDisabled();
  element.dispatchEvent(new Event('cancel', { cancelable: true }));
  await expect(element).toBeVisible();
  await expect(context.args.onClose).not.toHaveBeenCalled();
}

export const Initial: Story = { async play(context) {
  await meta.play(context);
  await expect(within(context.canvas.getByRole('dialog')).getByLabelText(i18n.t('videos.upload.titleLabel'), { exact: false })).toHaveValue('');
} };
export const FileSelected: Story = { async play(context) {
  const dialog = await fillFile(context);
  await expect(dialog.getByLabelText(i18n.t('videos.upload.titleLabel'), { exact: false })).toHaveValue('線形代数の講義');
} };
export const CancelCompression: Story = {
  parameters: { uploadModal: { compressing: true } satisfies ModalScenario },
  async play(context) {
    const dialog = await fillFile(context);
    await context.userEvent.click(dialog.getByRole('radio', { name: i18n.t('videos.upload.compression.presets.1080p') }));
    await context.userEvent.click(dialog.getByRole('button', { name: i18n.t('videos.upload.compression.submit') }));
    await expect(dialog.getByRole('progressbar')).toHaveAccessibleName(i18n.t('videos.upload.compression.compressing'));
    await context.userEvent.click(dialog.getByRole('button', { name: i18n.t('videos.upload.compression.cancel') }));
    await expect(dialog.getByText(i18n.t('videos.upload.compression.canceled'))).toBeVisible();
    await expect(dialog.getByLabelText(i18n.t('videos.upload.titleLabel'), { exact: false })).toHaveValue('線形代数の講義');
    await expect(context.args.onClose).not.toHaveBeenCalled();
  },
};
export const YoutubeInput: Story = { async play(context) { await fillYoutube(context); } };
export const SwitchSource: Story = { async play(context) {
  const dialog = await fillFile(context);
  await context.userEvent.click(dialog.getByRole('button', { name: i18n.t('videos.upload.modes.youtube') }));
  await expect(dialog.getByLabelText(i18n.t('videos.upload.titleLabel'), { exact: false })).toHaveValue('線形代数の講義');
  await expect(dialog.getByRole('button', { name: i18n.t('videos.upload.modes.youtube') })).toHaveAttribute('aria-pressed', 'true');
  await context.userEvent.click(dialog.getByRole('button', { name: i18n.t('videos.upload.modes.file') }));
  await expect(dialog.getByLabelText(i18n.t('videos.upload.descriptionLabel'), { exact: false })).toHaveValue('第1回の講義と演習');
} };
export const SelectedTags: Story = { async play(context) {
  const dialog = await fillFile(context);
  await context.userEvent.click(dialog.getByRole('button', { name: tags[0].name }));
  await context.userEvent.click(dialog.getByRole('button', { name: tags[1].name }));
  await expect(dialog.getByRole('button', { name: tags[1].name })).toHaveAttribute('aria-pressed', 'true');
  await context.userEvent.click(dialog.getByRole('button', { name: i18n.t('videos.upload.compression.submit') }));
  await expect(uploadRequest).toHaveBeenCalledWith(expect.objectContaining({ fileName, tagIds: [tags[0].id, tags[1].id] }));
} };
export const CreateTag: Story = { async play(context) {
  const create = await openTagCreate(context);
  await context.userEvent.click(create.getByRole('button', { name: i18n.t('common.actions.create') }));
  await waitFor(() => expect(context.canvas.queryByRole('dialog', { name: i18n.t('tags.create.title') })).not.toBeInTheDocument());
  const dialog = within(context.canvas.getByRole('dialog'));
  await expect(await dialog.findByRole('button', { name: createTagName })).toBeVisible();
  await expect(dialog.getByRole('button', { name: `+ ${i18n.t('tags.selector.createNew')}` })).toHaveFocus();
  await context.userEvent.click(dialog.getByRole('button', { name: createTagName }));
  await expect(createTagRequest).toHaveBeenCalledWith(expect.objectContaining({ name: createTagName }));
  await expect(dialog.getByLabelText(i18n.t('videos.upload.titleLabel'), { exact: false })).toHaveValue('線形代数の講義');
} };
export const TagCreating: Story = {
  parameters: { uploadModal: { tagResult: 'pending' } satisfies ModalScenario },
  async play(context) {
    const create = await openTagCreate(context);
    await context.userEvent.click(create.getByRole('button', { name: i18n.t('common.actions.create') }));
    await expect(await create.findByRole('button', { name: i18n.t('common.actions.creating') })).toBeDisabled();
    context.canvas.getByRole('dialog', { name: i18n.t('tags.create.title') }).dispatchEvent(new Event('cancel', { cancelable: true }));
    await expect(context.canvas.getByRole('dialog', { name: i18n.t('tags.create.title') })).toBeVisible();
  },
};
export const TagFailureThenRetry: Story = {
  parameters: { uploadModal: { tagResult: 'retry' } satisfies ModalScenario },
  async play(context) {
    const create = await openTagCreate(context);
    await context.userEvent.click(create.getByRole('button', { name: i18n.t('common.actions.create') }));
    await waitFor(() => expect(createTagRequest).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(create.getByRole('button', { name: i18n.t('common.actions.create') })).toBeEnabled());
    await context.userEvent.click(create.getByRole('button', { name: i18n.t('common.actions.create') }));
    await waitFor(() => expect(context.canvas.queryByRole('dialog', { name: i18n.t('tags.create.title') })).not.toBeInTheDocument());
    await expect(await within(context.canvas.getByRole('dialog')).findByRole('button', { name: createTagName })).toBeVisible();
    await expect(createTagRequest).toHaveBeenCalledTimes(2);
  },
};
export const Uploading: Story = {
  parameters: { uploadModal: { result: 'pending', progress: 46 } satisfies ModalScenario },
  async play(context) {
    const dialog = await fillFile(context);
    await context.userEvent.click(dialog.getByRole('button', { name: i18n.t('videos.upload.compression.submit') }));
    await assertBusy(context);
    await expect(dialog.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '46');
  },
};
export const YoutubeImporting: Story = {
  parameters: { uploadModal: { result: 'pending' } satisfies ModalScenario },
  async play(context) {
    const dialog = await fillYoutube(context);
    await context.userEvent.click(dialog.getByRole('button', { name: i18n.t('videos.upload.upload') }));
    await assertBusy(context);
    await expect(dialog.queryByRole('progressbar')).not.toBeInTheDocument();
  },
};
export const Success: Story = { async play(context) {
  const dialog = await fillFile(context);
  await context.userEvent.click(dialog.getByRole('button', { name: i18n.t('videos.upload.compression.submit') }));
  await expect(await dialog.findByText(i18n.t('videos.upload.success'))).toBeVisible();
  await expect(context.args.onClose).not.toHaveBeenCalled();
} };
export const Warning: Story = {
  parameters: { uploadModal: { result: 'warning' } satisfies ModalScenario },
  async play(context) {
    await Success.play!(context);
    await expect(within(context.canvas.getByRole('dialog')).getByText(i18n.t('videos.upload.warning.tagsFailed'))).toBeVisible();
  },
};
export const AutoClose: Story = {
  args: { autoCloseDelayMs: undefined },
  async play(context) {
    await Success.play!(context);
    await waitFor(() => expect(context.canvas.queryByRole('dialog')).not.toBeInTheDocument(), { timeout: 4000 });
    await expect(context.args.onClose).toHaveBeenCalledTimes(1);
    await expect(context.canvas.getByRole('button', { name: i18n.t('videos.upload.title') })).toHaveFocus();
    await meta.play(context);
    await expect(within(context.canvas.getByRole('dialog')).getByLabelText(i18n.t('videos.upload.titleLabel'), { exact: false })).toHaveValue('');
  },
};
export const UploadFailed: Story = {
  parameters: { uploadModal: { result: 'error' } satisfies ModalScenario },
  async play(context) {
    const dialog = await fillFile(context);
    await context.userEvent.click(dialog.getByRole('button', { name: i18n.t('videos.upload.compression.submit') }));
    await expect(await dialog.findByText(uploadError)).toBeVisible();
    await expect(dialog.getByRole('button', { name: i18n.t('videos.upload.compression.submit') })).toBeEnabled();
    await expect(dialog.queryByText(i18n.t('videos.upload.success'))).not.toBeInTheDocument();
  },
};
export const FailureThenRetry: Story = {
  parameters: { uploadModal: { result: 'retry' } satisfies ModalScenario },
  async play(context) {
    await UploadFailed.play!(context);
    const dialog = within(context.canvas.getByRole('dialog'));
    await context.userEvent.click(dialog.getByRole('button', { name: i18n.t('videos.upload.compression.submit') }));
    await expect(await dialog.findByText(i18n.t('videos.upload.success'))).toBeVisible();
    await expect(dialog.queryByText(uploadError)).not.toBeInTheDocument();
    await expect(uploadRequest).toHaveBeenCalledTimes(2);
  },
};
export const MonthlyUploadLimit: Story = {
  parameters: { uploadModal: {
    result: 'error', error: 'videos.upload.validation.monthlyUploadLimitExceeded',
  } satisfies ModalScenario },
  async play(context) {
    const dialog = await fillFile(context);
    await context.userEvent.click(dialog.getByRole('button', { name: i18n.t('videos.upload.compression.submit') }));
    await expect(await dialog.findByText(i18n.t('videos.upload.validation.monthlyUploadLimitExceeded'))).toBeVisible();
    await expect(dialog.getByLabelText(i18n.t('videos.upload.titleLabel'), { exact: false })).toHaveValue('線形代数の講義');
    await expect(dialog.getByRole('button', { name: i18n.t('videos.upload.compression.submit') })).toBeEnabled();
    await expect(context.args.onClose).not.toHaveBeenCalled();
  },
};
export const MonthlyUploadLimitEnglishMobile: Story = {
  ...MonthlyUploadLimit,
  globals: { locale: 'en', viewport: { value: 'mobile', isRotated: false } },
};
export const LongContentMobile: Story = {
  globals: { viewport: { value: 'mobile', isRotated: false } },
  parameters: { uploadModal: { tags: [...tags, ...manyTags] } satisfies ModalScenario },
  async play(context) {
    const dialog = await fillFile(context);
    await context.userEvent.type(dialog.getByLabelText(i18n.t('videos.upload.titleLabel'), { exact: false }), '・行列の基本操作と連立一次方程式の解法を学ぶ共同学習用の講義資料');
    await context.userEvent.type(dialog.getByLabelText(i18n.t('videos.upload.descriptionLabel'), { exact: false }), '\n講義・演習・復習用の資料をまとめて確認し、複数のタグで学習内容を整理します。');
  },
};
export const EnglishMobile: Story = {
  globals: { locale: 'en', viewport: { value: 'mobile', isRotated: false } },
  parameters: { uploadModal: { tags: englishTags } satisfies ModalScenario },
  async play(context) { await fillYoutube(context); },
};
export const KeyboardUpload: Story = { async play(context) {
  await meta.play(context);
  const dialog = within(context.canvas.getByRole('dialog'));
  await context.userEvent.tab();
  await expect(dialog.getByRole('button', { name: i18n.t('videos.upload.modes.file') })).toHaveFocus();
  await context.userEvent.tab(); await context.userEvent.keyboard('{Enter}');
  await context.userEvent.tab(); await context.userEvent.keyboard(youtubeUrl);
  await context.userEvent.tab(); await context.userEvent.keyboard('Keyboard upload');
  const submit = dialog.getByRole('button', { name: i18n.t('videos.upload.upload') });
  for (let index = 0; index < 10 && context.canvasElement.ownerDocument.activeElement !== submit; index++) await context.userEvent.tab();
  await expect(submit).toHaveFocus();
  await context.userEvent.keyboard('{Enter}');
  await expect(await dialog.findByText(i18n.t('videos.upload.success'))).toBeVisible();
  await expect(uploadRequest).toHaveBeenCalledWith(expect.objectContaining({ sourceMode: 'youtube', youtubeUrl, title: 'Keyboard upload' }));
} };
export const CancelAndReopen: Story = { async play(context) {
  const dialog = await fillFile(context);
  await context.userEvent.click(dialog.getByRole('button', { name: i18n.t('common.actions.cancel') }));
  await expect(context.canvas.queryByRole('dialog')).not.toBeInTheDocument();
  await expect(context.canvas.getByRole('button', { name: i18n.t('videos.upload.title') })).toHaveFocus();
  await meta.play(context);
  await expect(within(context.canvas.getByRole('dialog')).getByLabelText(i18n.t('videos.upload.titleLabel'), { exact: false })).toHaveValue('');
} };
export const EscapeRequest: Story = { async play(context) {
  await meta.play(context);
  context.canvas.getByRole('dialog').dispatchEvent(new Event('cancel', { cancelable: true }));
  await waitFor(() => expect(context.canvas.queryByRole('dialog')).not.toBeInTheDocument());
  await expect(context.canvas.getByRole('button', { name: i18n.t('videos.upload.title') })).toHaveFocus();
} };
export const FilePickerCancelled: Story = { async play(context) {
  await meta.play(context);
  const dialog = within(context.canvas.getByRole('dialog'));
  dialog.getByLabelText(i18n.t('videos.upload.fileLabel'), { exact: false, selector: 'input[type="file"]' }).dispatchEvent(new Event('cancel', { bubbles: true }));
  await expect(context.canvas.getByRole('dialog')).toBeVisible();
  await expect(context.args.onClose).not.toHaveBeenCalled();
} };
