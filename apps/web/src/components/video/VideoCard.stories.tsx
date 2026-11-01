import type { Meta, StoryObj } from '@storybook/react-vite';
import { useLocation } from 'react-router-dom';
import { expect, fn, waitFor } from 'storybook/test';
import i18n from '@/i18n/config';
import { englishVideo, longVideo, mediaHandlers, uploadedVideo, youtubeThumbnailUrl, youtubeVideo } from '../../../.storybook/fixtures/videos';
import { manyTags } from '../../../.storybook/fixtures/tags';
import { VideoCard } from './VideoCard';

function CurrentPath() {
  const { pathname } = useLocation();
  return <output className="sr-only" data-testid="current-path">{pathname}</output>;
}

const meta = {
  title: 'Video/VideoCard',
  component: VideoCard,
  args: { video: uploadedVideo, showLink: true },
  parameters: {
    pathname: '/videos',
    msw: mediaHandlers,
    docs: { description: { component: 'アップロード動画はローカルの2秒のWebMを使用します。YouTubeサムネイルはMSWが固定のSVGを返します。実APIや外部動画に接続せず、実際のIntersectionObserverとホバー再生を確認できます。' } },
  },
  decorators: [(Story) => <div className="max-w-3xl"><Story /><CurrentPath /></div>],
} satisfies Meta<typeof VideoCard>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Uploaded: Story = {
  play: async ({ canvas, userEvent, args, globals }) => {
    const link = canvas.getByRole('link');
    const path = `${globals.locale === 'en' ? '/en' : ''}/videos/${args.video.id}`;
    await expect(link).toHaveAttribute('href', path);
    await userEvent.tab();
    await expect(link).toHaveFocus();
    await userEvent.keyboard('{Enter}');
    await expect(canvas.getByTestId('current-path')).toHaveTextContent(path);
    const date = new Date(args.video.uploaded_at).toLocaleString(i18n.language, {
      year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
    });
    await expect(canvas.getByText(date)).toBeVisible();
  },
};
export const YouTube: Story = {
  args: { video: youtubeVideo },
  play: async ({ canvas, args }) => {
    const image = canvas.getByRole<HTMLImageElement>('img', { name: args.video.title });
    await expect(image).toHaveAttribute('src', youtubeThumbnailUrl);
    await waitFor(async () => {
      await expect(image.complete).toBe(true);
      await expect(image.naturalWidth).toBe(320);
    });
  },
};
export const NoMedia: Story = { args: { video: { ...uploadedVideo, file: null, tags: [] } } };
export const MissingYouTubeId: Story = { args: { video: { ...youtubeVideo, youtube_video_id: null } } };
export const Uploading: Story = { args: { video: { ...uploadedVideo, status: 'uploading', file: null } } };
export const Pending: Story = { args: { video: { ...uploadedVideo, status: 'pending' } } };
export const Processing: Story = { args: { video: { ...uploadedVideo, status: 'processing' } } };
export const Indexing: Story = { args: { video: { ...uploadedVideo, status: 'indexing' } } };
export const Error: Story = { args: { video: { ...uploadedVideo, status: 'error', file: null } } };
export const LongTitleManyTags: Story = {
  args: { video: { ...longVideo, tags: [...longVideo.tags!, ...manyTags.slice(0, 8)] } },
  globals: { viewport: { value: 'mobile', isRotated: false } },
};
export const PlainCard: Story = { args: { showLink: false } };
export const KeyboardClick: Story = {
  args: { showLink: false, onClick: fn() },
  play: async ({ canvas, userEvent, args }) => {
    const button = canvas.getByRole('button');
    await userEvent.click(button);
    await expect(button).toHaveFocus();
    await userEvent.keyboard('{Enter}');
    await userEvent.keyboard(' ');
    await expect(args.onClick).toHaveBeenCalledTimes(3);
    await expect(canvas.queryByRole('link')).not.toBeInTheDocument();
  },
};
export const HoverPreview: Story = {
  play: async ({ canvas, canvasElement, userEvent, args }) => {
    await waitFor(() => expect(canvasElement.querySelector('video')).not.toBeNull());
    const video = canvasElement.querySelector('video')!;
    await expect(video.src).toBe(args.video.file);
    await expect(video.muted).toBe(true);
    const title = canvas.getByText(args.video.title);
    // preload="metadata" need not decode a frame until playback is requested.
    await userEvent.hover(title);
    await waitFor(() => expect(video.currentTime).toBeGreaterThan(0), { timeout: 3000 });
    await expect(video.paused).toBe(false);
    await userEvent.unhover(title);
    await expect(video.paused).toBe(true);
    await expect(video.currentTime).toBe(0);
  },
};
export const EnglishMobile: Story = {
  args: { video: englishVideo },
  globals: { locale: 'en', viewport: { value: 'mobile', isRotated: false } },
  play: Uploaded.play,
};
