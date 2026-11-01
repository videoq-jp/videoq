import { useState, type ComponentProps } from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, fn, waitFor } from 'storybook/test';
import i18n from '@/i18n/config';
import { filterTranscriptSegments, parseSrtTranscript } from '@/lib/transcript/srt';
import { detailVideo, englishVideo, longText, segments, transcript } from '../../../../.storybook/fixtures/detail';
import { TranscriptPanel } from './TranscriptPanel';

const label = (key: string) => i18n.t(`videos.detail.${key}`);
const saveError = '字幕を保存できませんでした / Could not save the transcript.';
function Example(args: ComponentProps<typeof TranscriptPanel> & { outcome?: 'pending' | 'error' }) {
  const [video, setVideo] = useState(args.video);
  const [query, setQuery] = useState(args.transcriptSearch);
  const [editing, setEditing] = useState(args.isTranscriptEditing);
  const [value, setValue] = useState(args.editedTranscript);
  const [saving, setSaving] = useState(args.isTranscriptSaving);
  const [error, setError] = useState(args.transcriptSaveError);
  const [active, setActive] = useState(args.activeSegmentIdx);
  const parsed = parseSrtTranscript(video.transcript ?? '');
  return <div data-testid="transcript-frame" className="relative grid h-[640px] max-w-[640px]">
    <TranscriptPanel {...args} video={video} transcriptSearch={query} onTranscriptSearchChange={setQuery}
      filteredSegments={filterTranscriptSegments(parsed, query)} isPlainTextTranscript={!!video.transcript?.trim() && parsed.length === 0}
      isTranscriptEditing={editing} editedTranscript={value} isTranscriptSaving={saving} transcriptSaveError={error} activeSegmentIdx={active}
      onStartTranscriptEditing={() => { args.onStartTranscriptEditing(); setEditing(true); setValue(video.transcript ?? ''); setError(null); }}
      onCancelTranscriptEditing={() => { args.onCancelTranscriptEditing(); setEditing(false); setError(null); }}
      onEditedTranscriptChange={setValue}
      onSaveTranscript={() => { args.onSaveTranscript(); if (args.outcome === 'pending') setSaving(true); else if (args.outcome === 'error') setError(saveError); else { setVideo({ ...video, transcript: value }); setEditing(false); } }}
      onSeek={(seconds, index) => { args.onSeek(seconds, index); setActive(index); }} />
  </div>;
}
const meta = {
  title: 'Video/TranscriptPanel', component: TranscriptPanel,
  args: { video: detailVideo, isMobile: false, mobileTab: 'transcript', transcriptSearch: '', isTranscriptEditing: false,
    editedTranscript: transcript, isTranscriptSaving: false, transcriptSaveError: null, filteredSegments: segments, activeSegmentIdx: null, isPlainTextTranscript: false,
    onTranscriptSearchChange: fn(), onStartTranscriptEditing: fn(), onCancelTranscriptEditing: fn(), onEditedTranscriptChange: fn(), onSaveTranscript: fn(), onSeek: fn() },
  render: (args, { parameters }) => <Example {...args} outcome={parameters.outcome} />,
} satisfies Meta<typeof TranscriptPanel>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Default: Story = { async play({ canvas }) { await expect(canvas.getByRole('button', { name: /00:00:05/ })).toBeVisible(); } };
export const NoTranscript: Story = { args: { video: { ...detailVideo, transcript: '' } }, async play({ canvas, userEvent }) { await expect(canvas.getByText(label('transcriptStatus.unavailable'))).toBeVisible(); await userEvent.click(canvas.getByRole('button', { name: label('editTranscriptButton') })); await expect(canvas.getByRole('textbox')).toHaveValue(''); } };
export const Processing: Story = { args: { video: { ...detailVideo, transcript: '', status: 'processing' } }, async play({ canvas }) { await expect(canvas.getByText(label('transcriptStatus.processing'))).toBeVisible(); } };
export const PlainText: Story = { args: { video: { ...detailVideo, transcript: '時刻情報のない字幕です。\n複数行をそのまま表示します。' } }, async play({ canvas }) { await expect(canvas.getByText(/時刻情報のない字幕/)).toBeVisible(); } };
export const ActiveSegment: Story = { args: { activeSegmentIdx: 1 }, async play({ canvas }) { await expect(canvas.getByRole('button', { name: /00:00:05/ })).toHaveAttribute('aria-current', 'true'); } };
export const Search: Story = { async play({ canvas, userEvent }) { await userEvent.type(canvas.getByRole('searchbox'), '座標'); await expect(canvas.getByRole('button', { name: /00:00:05/ })).toBeVisible(); await expect(canvas.queryByRole('button', { name: /00:00:12/ })).not.toBeInTheDocument(); } };
export const NoSearchResults: Story = { args: { transcriptSearch: '見つからない語句' }, async play({ canvas }) { await expect(canvas.getByText(label('transcriptNotFound'))).toBeVisible(); } };
export const Editing: Story = { async play({ canvas, userEvent }) { await userEvent.click(canvas.getByRole('button', { name: label('editTranscriptButton') })); await expect(canvas.getByRole('textbox', { name: label('transcriptSection') })).toHaveFocus(); } };
const longEditableTranscript = Array.from({ length: 150 }, (_, index) => `字幕 ${index + 1}: 長い文字起こしの編集内容です。`).join('\n');
export const EditingFullHeight: Story = {
  args: { video: { ...detailVideo, transcript: longEditableTranscript } },
  async play(context) {
    await Editing.play!(context);
    const textbox = context.canvas.getByRole<HTMLTextAreaElement>('textbox');
    const panel = context.canvas.getByRole('heading').closest('div.flex.min-h-\\[31\\.25rem\\]')!;
    await expect(textbox.clientHeight).toBeGreaterThan(250);
    await expect(Math.abs(textbox.getBoundingClientRect().bottom - panel.getBoundingClientRect().bottom)).toBeLessThan(3);
    textbox.scrollTop = textbox.scrollHeight;
    await expect(textbox.scrollTop).toBeGreaterThan(0);
    await expect(textbox.scrollTop + textbox.clientHeight).toBeGreaterThanOrEqual(textbox.scrollHeight - 1);
    await expect(textbox).toHaveValue(longEditableTranscript);
  },
};
export const EditingFullHeightMobile: Story = {
  ...EditingFullHeight,
  globals: { viewport: { value: 'mobile', isRotated: false } },
  args: { ...EditingFullHeight.args, isMobile: true },
};
export const Saving: Story = { parameters: { outcome: 'pending' }, async play(context) { await Editing.play!(context); await context.userEvent.click(context.canvas.getByRole('button', { name: label('saveTranscriptButton') })); for (const control of context.canvas.getAllByRole('button')) await expect(control).toBeDisabled(); await expect(context.canvas.getByRole('textbox')).toBeDisabled(); } };
export const SaveFailed: Story = { parameters: { outcome: 'error' }, async play(context) { await Editing.play!(context); await context.userEvent.type(context.canvas.getByRole('textbox'), '\n修正内容'); await context.userEvent.click(context.canvas.getByRole('button', { name: label('saveTranscriptButton') })); await expect(context.canvas.getByRole('alert')).toHaveTextContent(saveError); await expect(context.canvas.getByRole('textbox')).toHaveValue(transcript + '\n修正内容'); await waitFor(() => expect(context.canvas.getByRole('alert').parentElement).toHaveFocus()); } };
export const SaveSucceeded: Story = { async play(context) { await Editing.play!(context); await context.userEvent.clear(context.canvas.getByRole('textbox')); await context.userEvent.type(context.canvas.getByRole('textbox'), '更新した字幕'); await context.userEvent.click(context.canvas.getByRole('button', { name: label('saveTranscriptButton') })); await expect(context.canvas.getByText('更新した字幕')).toBeVisible(); await expect(context.canvas.getByRole('button', { name: label('editTranscriptButton') })).toHaveFocus(); } };
export const CancelEdit: Story = { async play(context) { await Editing.play!(context); await context.userEvent.clear(context.canvas.getByRole('textbox')); await context.userEvent.click(context.canvas.getByRole('button', { name: label('cancel') })); await expect(context.canvas.getByRole('button', { name: /00:00:00/ })).toBeVisible(); await expect(context.canvas.getByRole('button', { name: label('editTranscriptButton') })).toHaveFocus(); } };
export const KeyboardSeek: Story = { async play({ canvas, userEvent, args }) { canvas.getByRole('searchbox').focus(); await userEvent.tab(); await userEvent.keyboard('{Enter}'); await expect(args.onSeek).toHaveBeenCalledWith(0, 0); await userEvent.tab(); await userEvent.keyboard(' '); await expect(args.onSeek).toHaveBeenLastCalledWith(5, 1); await expect(canvas.getByRole('button', { name: /00:00:05/ })).toHaveFocus(); } };
export const LongTranscriptMobile: Story = { globals: { viewport: { value: 'mobile', isRotated: false } }, args: { isMobile: true, video: { ...detailVideo, transcript: transcript.replace(segments[0].text, longText) } }, async play({ canvas }) { const frame = canvas.getByTestId('transcript-frame'); await expect(frame.scrollWidth).toBeLessThanOrEqual(frame.clientWidth); } };
export const EnglishMobile: Story = { globals: { locale: 'en', viewport: { value: 'mobile', isRotated: false } }, args: { isMobile: true, video: englishVideo }, async play({ canvas }) { await expect(canvas.getByRole('button', { name: /Introducing rotation/ })).toBeVisible(); } };
export const HiddenMobileTab: Story = { args: { isMobile: true, mobileTab: 'video' }, async play({ canvas }) { await expect(canvas.queryByRole('heading')).not.toBeInTheDocument(); } };
