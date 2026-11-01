import type { Meta, StoryObj } from '@storybook/react-vite';
import { useState, type ComponentProps } from 'react';
import { expect, fn } from 'storybook/test';
import i18n from '@/i18n/config';
import { VideoUploadFormFields } from './VideoUploadFormFields';

function UploadFormExample(args: ComponentProps<typeof VideoUploadFormFields>) {
  const [language, setLanguage] = useState<NonNullable<ComponentProps<typeof VideoUploadFormFields>['transcriptionLanguage']>>(args.transcriptionLanguage ?? (i18n.language.startsWith('en') ? 'en' : 'ja'));
  const [title, setTitle] = useState(args.title);
  const [description, setDescription] = useState(args.description);
  const [compressionPreset, setCompressionPreset] = useState<'1080p' | '720p'>(args.compressionPreset ?? '1080p');
  return (
    <form className="space-y-4" style={{ maxWidth: 560 }} onSubmit={(event) => event.preventDefault()}>
      <VideoUploadFormFields
        {...args}
        transcriptionLanguage={language}
        setTranscriptionLanguage={value => { args.setTranscriptionLanguage?.(value); setLanguage(value); }}
        title={title}
        description={description}
        compressionPreset={compressionPreset}
        setCompressionPreset={(value) => { args.setCompressionPreset?.(value); setCompressionPreset(value); }}
        setTitle={(value) => { args.setTitle(value); setTitle(value); }}
        setDescription={(value) => { args.setDescription(value); setDescription(value); }}
      />
    </form>
  );
}

const meta = {
  title: 'Video/VideoUploadFormFields',
  component: VideoUploadFormFields,
  parameters: {
    docs: { description: { component: 'Compact compression choices without persistent guidance paragraphs. Browser support and processing errors appear when relevant.' } },
  },
  args: {
    title: '',
    description: '',
    isUploading: false,
    progress: 0,
    disabled: false,
    error: null,
    warning: null,
    success: false,
    setTitle: fn(),
    setDescription: fn(),
    handleFileChange: fn(),
    onCancel: fn(),
    compressionSupported: true,
    setCompressionPreset: fn(),
  },
  render: (args) => <UploadFormExample key={JSON.stringify([args.title, args.description, args.compressionPreset])} {...args} />,
} satisfies Meta<typeof VideoUploadFormFields>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Empty: Story = {};
export const Filled: Story = { args: { title: '線形代数 第3回：回転行列', description: '座標変換の基本と回転行列の具体例を解説する講義です。' } };
export const CompressionUnavailable: Story = { args: { compressionSupported: false }, async play({ canvas }) {
  await expect(canvas.getByRole('radio', { name: i18n.t('videos.upload.compression.presets.1080p') })).toBeDisabled();
  await expect(canvas.getByRole('radio', { name: i18n.t('videos.upload.compression.presets.1080p') })).toBeChecked();
  await expect(canvas.getByRole('button', { name: i18n.t('videos.upload.compression.submit') })).toBeDisabled();
} };
export const SelectCompression: Story = { async play({ canvas, userEvent }) {
  const standard = canvas.getByRole('radio', { name: i18n.t('videos.upload.compression.presets.1080p') });
  await userEvent.click(standard);
  await expect(standard).toBeChecked();
  await expect(canvas.getByRole('button', { name: i18n.t('videos.upload.compression.submit') })).toBeEnabled();
  await userEvent.keyboard('{ArrowDown}');
  await expect(canvas.getByRole('radio', { name: i18n.t('videos.upload.compression.presets.720p') })).toBeChecked();
} };
export const Compressing: Story = { args: { ...Filled.args, compressionPreset: '1080p', isUploading: true, isCompressing: true, progress: 36 } };
export const CompressionFailure: Story = { args: { ...Filled.args, compressionPreset: '720p', error: 'videos.upload.compression.unsupportedFile' } };
export const CompressedUpload: Story = { args: { ...Filled.args, compressionPreset: '1080p', isUploading: true, progress: 46, compressedSizes: { before: 45_159_504_400, after: 9_000_000_000 } } };
export const Disabled: Story = { args: { ...Filled.args, disabled: true } };
export const StartingUpload: Story = { args: { ...Filled.args, isUploading: true, progress: 0 } };
export const Uploading: Story = { args: { ...Filled.args, isUploading: true, progress: 46 } };
export const UploadComplete: Story = { args: { ...Filled.args, isUploading: true, progress: 100 } };
export const Error: Story = { args: { ...Filled.args, error: 'videos.upload.validation.monthlyUploadLimitExceeded' } };
export const StorageLimitError: Story = { args: { error: 'videos.upload.validation.storageLimitExceeded' } };
export const Warning: Story = { args: { ...Filled.args, warning: 'videos.upload.warning.tagsFailed', success: true } };
export const Success: Story = { args: { ...Filled.args, success: true } };
export const WithCancel: Story = {
  args: { showCancelButton: true },
  play: async ({ canvas, userEvent, args }) => {
    await userEvent.click(canvas.getByRole('button', { name: i18n.t('common.actions.cancel') }));
    await expect(args.onCancel).toHaveBeenCalledTimes(1);
  },
};
export const FillForm: Story = {
  play: async ({ canvas, userEvent, args }) => {
    const [title, description] = canvas.getAllByRole('textbox');
    await userEvent.type(title, '線形代数の講義');
    await userEvent.type(description, '回転行列の解説');
    await expect(title).toHaveValue('線形代数の講義');
    await expect(description).toHaveValue('回転行列の解説');
    const file = new File(['storybook input fixture'], 'lecture.mp4', { type: 'video/mp4' });
    await userEvent.upload(canvas.getByLabelText(i18n.t('videos.upload.fileLabel'), { exact: false, selector: 'input[type="file"]' }), file);
    await expect(args.handleFileChange).toHaveBeenCalledTimes(1);
  },
};
export const EnglishMobile: Story = {
  args: { title: 'Linear algebra: rotation matrices', description: 'A lecture about coordinate transformations.', compressionPreset: '720p', isUploading: true, isCompressing: true, progress: 46 },
  globals: { locale: 'en', viewport: { value: 'mobile', isRotated: false } },
};

export const SelectAudioLanguage: Story = {
  async play({ canvas, userEvent }) {
    const language = canvas.getByRole('combobox', { name: i18n.t('videos.upload.languageLabel') });
    await userEvent.selectOptions(language, 'ja');
    await expect(language).toHaveValue('ja');
    await userEvent.selectOptions(language, 'en');
    await expect(language).toHaveValue('en');
  },
};
