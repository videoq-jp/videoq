import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, fn, mocked, waitFor, within } from 'storybook/test';
import App from './App';
import i18n from './i18n/config';
import { appQueryClient } from './lib/queryClient';
import { trpc } from './lib/trpc';
import { useAuthSession } from './lib/authSession';
import { authFixtures } from '../.storybook/fixtures/auth';
import { emptyTagPage } from '../.storybook/fixtures/api';
import { course, courseVideos, detailVideo } from '../.storybook/fixtures/detail';
import { installUploadFixture } from '../.storybook/mocks/videoUpload';
import { failure, pending, success, trpcMutation, trpcQuery } from '../.storybook/mocks/network';
import { chatRequest, createChatPanelMock } from '../.storybook/mocks/chatPanel';

const emptyPage = { data: [], meta: { total: 0, limit: 24, offset: 0 } };
const api = {
  auth: authFixtures.user,
  trpc: [
    trpcQuery('billing.plans', success([])),
    trpcQuery('videos.list', success(emptyPage)),
    trpcQuery('courses.list', success(emptyPage)),
    trpcQuery('tags.list', success(emptyTagPage)),
    trpcQuery('videos.statusCounts', success({
      total: 0, completed: 0, pending: 0, processing: 0, indexing: 0, error: 0, uploading: 0,
    })),
  ],
};

const meta = {
  title: 'Application/Navigation',
  component: App,
  globals: { viewport: { value: 'desktop', isRotated: false } },
  parameters: { layout: 'fullscreen', pathname: '/pricing', api, docs: { story: { inline: false, height: '900px' } } },
  async beforeEach() {
    // Browser stories verify layout and interactions. The navigation unit test
    // controls lazy-module delays explicitly; await cold Vite imports here.
    await Promise.all([
      import('./pages/HomeDashboard'), import('./pages/PricingPage'),
      import('./pages/LoginPage'), import('./pages/SignupPage'),
      import('./pages/VideoLibraryPage'), import('./pages/VideoDetailPage'),
      import('./pages/VideoCoursesPage'), import('./pages/VideoCourseDetailPage'),
      import('./pages/SharePage'), import('./pages/CourseInvitationPage'),
    ]);
    const cleanupUpload = installUploadFixture({});
    const saved = localStorage.getItem('videoq.locale');
    localStorage.removeItem('videoq.locale');
    return () => {
      cleanupUpload();
      if (saved === null) localStorage.removeItem('videoq.locale');
      else localStorage.setItem('videoq.locale', saved);
    };
  },
} satisfies Meta<typeof App>;
export default meta;
type Story = StoryObj<typeof meta>;

export const SharedCourseNotice: Story = {
  parameters: {
    pathname: '/share/linear-algebra',
    api: {
      auth: authFixtures.loggedOut,
      trpc: [trpcQuery('courses.shared', success({
        ...course, videos: courseVideos, video_count: courseVideos.length,
        updated_at: course.created_at, share_slug: 'linear-algebra', access_role: 'public',
      }))],
    },
  },
  async play({ canvasElement, userEvent }) {
    const canvas = within(canvasElement);
    await expect(await canvas.findByRole('heading', { level: 1, name: course.name })).toBeInTheDocument();
    await expect(canvas.queryByText(i18n.t('courseSharing.quotaAndHistory'))).not.toBeInTheDocument();
    await expect(canvas.queryByText(i18n.t('courseSharing.link'))).not.toBeInTheDocument();
    await userEvent.click(canvas.getByRole('tab', { name: i18n.t('videos.shared.tabs.videos') }));
    const second = canvas.getByRole('button', { name: new RegExp(courseVideos[1].title) });
    second.focus();
    await expect(second).toHaveFocus();
    await userEvent.keyboard('{Enter}');
    await expect(canvas.getByRole('heading', { name: courseVideos[1].title })).toBeVisible();
    const first = canvas.getByRole('button', { name: new RegExp(courseVideos[0].title) });
    first.focus();
    await userEvent.keyboard(' ');
    await expect(canvas.getByRole('heading', { name: courseVideos[0].title })).toBeVisible();
  },
};
export const SharedCourseNoticeEnglishMobile: Story = {
  ...SharedCourseNotice,
  globals: { locale: 'en', viewport: { value: 'mobile', isRotated: false } },
};

let courseChatNetwork: ReturnType<typeof createChatPanelMock>;
export const CourseChatContinuity: Story = {
  parameters: {
    pathname: `/videos/courses/${course.id}`,
    api: { ...api, trpc: [...api.trpc, trpcQuery('courses.get', success(course))] },
  },
  beforeEach({ msw }) {
    const mock = createChatPanelMock({ events: [], keepOpen: true });
    courseChatNetwork = mock;
    // Keep the app's account/course tRPC handlers from the common decorator.
    msw.use(...mock.handlers.filter(({ info }) => info.path === '/api/chat/messages/stream'));
    return () => {
      mock.dispose();
    };
  },
  async play({ canvasElement, userEvent, parameters }) {
    const canvas = within(canvasElement);
    const shared = parameters.pathname.startsWith('/share/');
    const english = i18n.language.startsWith('en');
    const original = english ? 'Explain rotation matrices' : '回転行列を学ぶ';
    const followup = english ? 'Explain with an example' : '具体例を教えてください';
    const reply = english ? 'Explain the relationship between input and output.' : '入力と出力の関係を説明してください。';
    const draft = english ? 'The length does not change.' : '長さは変わりません。';
    const input = await canvas.findByRole('textbox', { name: i18n.t('chat.placeholder') });
    // Include CSS-hidden panels: two separately mounted chats lose state on resize.
    await expect(canvas.getAllByRole('textbox', { hidden: true })).toHaveLength(1);
    const finish = async () => {
      await waitFor(() => expect(courseChatNetwork.activeStreams).toBe(1));
      courseChatNetwork.emit([{ type: 'text_delta', segmentIndex: 0, text: reply }, {
        type: 'done', chat_log_id: 101, feedback: null,
      }]);
      courseChatNetwork.finish();
      await waitFor(() => expect(input).toBeEnabled(), { timeout: 10000 });
      await expect(canvas.getAllByText(reply).at(-1)).toBeVisible();
    };
    const send = async (text: string, count: number) => {
      await userEvent.type(input, text);
      await userEvent.keyboard('{Enter}');
      await waitFor(() => expect(chatRequest).toHaveBeenCalledTimes(count));
    };
    const changePanelTab = async (tab: 'videos' | 'assistant') => {
      await userEvent.click(canvas.getByRole('tab', { name: i18n.t(`videos.shared.tabs.${tab}`) }));
      await expect(canvas.getByRole('textbox', { hidden: true })).toBe(input);
      if (tab === 'videos') await expect(input).not.toBeVisible();
      else await expect(input).toBeVisible();
    };
    await send(original, 1);
    await expect(chatRequest.mock.calls[0][0]).toMatchObject({ course_id: course.id });
    await finish();
    await send(followup, 2);
    const request = chatRequest.mock.calls[1][0];
    await expect(request.share_slug).toBe(shared ? 'linear-algebra' : undefined);
    await expect(request.messages).toEqual([{ role: 'user', content: followup }]);
    await changePanelTab('videos');
    await changePanelTab('assistant');
    await expect(input).toBeDisabled();
    await finish();
    await userEvent.type(input, draft);
    await changePanelTab('videos');
    await changePanelTab('assistant');
    await expect(input).toHaveValue(draft);
    await expect(canvas.getByText(followup)).toBeVisible();
  },
};
export const CourseViewerLayout: Story = {
  ...CourseChatContinuity,
  async play({ canvasElement, userEvent }) {
    const canvas = within(canvasElement);
    await expect(await canvas.findByRole('heading', { level: 1, name: course.name })).toBeVisible();
    await expect(canvas.queryByRole('button', { name: i18n.t('navigation.menu') })).not.toBeInTheDocument();
    const brand = canvas.getByRole('link', { name: 'VideoQ' });
    await expect(brand.querySelector('img')).toHaveAttribute('src', '/logo192.png');
    await expect(brand).toHaveAttribute('href', i18n.language.startsWith('en') ? '/en/videos/courses' : '/videos/courses');
    await expect(canvas.getByRole('tab', { name: i18n.t('videos.shared.tabs.assistant') })).toHaveAttribute('aria-selected', 'true');
    await expect(canvas.getByLabelText(i18n.t('videos.courseDetail.manage')).closest('details')).not.toHaveAttribute('open');
    await userEvent.click(canvas.getByLabelText(i18n.t('videos.courseDetail.manage')));
    await expect(canvas.getByRole('button', { name: i18n.t('videos.courseDetail.shareOpen') })).toBeVisible();
    await userEvent.click(canvas.getByRole('button', { name: i18n.t('videos.courseDetail.shareOpen') }));
    await expect(await canvas.findByRole('dialog')).toBeVisible();
  },
};
export const CourseViewerLayoutMobile: Story = {
  ...CourseViewerLayout, globals: { viewport: { value: 'mobile', isRotated: false } },
};
export const CourseViewerLayoutEnglishMobile: Story = {
  ...CourseViewerLayout, globals: { locale: 'en', viewport: { value: 'mobile', isRotated: false } },
};

export const CourseChatContinuityMobile: Story = {
  ...CourseChatContinuity, globals: { viewport: { value: 'mobile', isRotated: false } },
};
export const CourseChatContinuityEnglish: Story = { ...CourseChatContinuity, globals: { locale: 'en' } };
export const CourseChatContinuityEnglishMobile: Story = {
  ...CourseChatContinuity, globals: { locale: 'en', viewport: { value: 'mobile', isRotated: false } },
};
export const SharedChatContinuity: Story = { ...CourseChatContinuity, parameters: SharedCourseNotice.parameters };
export const SharedChatContinuityMobile: Story = { ...CourseChatContinuityMobile, parameters: SharedCourseNotice.parameters };
export const SharedChatContinuityEnglish: Story = { ...CourseChatContinuityEnglish, parameters: SharedCourseNotice.parameters };
export const SharedChatContinuityEnglishMobile: Story = { ...CourseChatContinuityEnglishMobile, parameters: SharedCourseNotice.parameters };

function youtubeReplayStory(scope: 'video' | 'course' | 'share'): Story {
  // A local blank document exercises iframe navigation without loading YouTube.
  const video = { ...detailVideo, source_type: 'youtube' as const, youtube_embed_url: 'about:blank' };
  const youtubeCourse = { ...course, videos: [{ ...video, order: 0 }] };
  return {
    parameters: {
      pathname: scope === 'video' ? `/videos/${video.id}` : scope === 'course' ? `/videos/courses/${course.id}` : '/share/linear-algebra',
      api: { ...api, auth: scope === 'share' ? authFixtures.loggedOut : authFixtures.user, trpc: [
        ...api.trpc,
        trpcQuery('videos.get', success(video)),
        trpcQuery('courses.get', success(youtubeCourse)),
        trpcQuery('courses.shared', success({
          ...youtubeCourse, updated_at: course.created_at, share_slug: 'linear-algebra', access_role: 'public',
        })),
      ] },
    },
    beforeEach({ msw }) {
      const mock = createChatPanelMock({ events: [
        { type: 'source', source: { id: 1, video_id: video.id, title: video.title, start_time: '00:00:05', end_time: null } },
        { type: 'text_delta', segmentIndex: 0, text: 'Replay this scene.' },
        { type: 'citation', segmentIndex: 0, sourceId: 1 },
        { type: 'done', chat_log_id: 101, feedback: null },
      ] });
      msw.use(...mock.handlers.filter(({ info }) => info.path === '/api/chat/messages/stream'));
      return () => mock.dispose();
    },
    async play({ canvas, canvasElement, userEvent, globals }) {
      let replay: HTMLElement;
      if (scope === 'video') {
        await canvas.findByRole('heading', { level: 1, name: video.title });
        if (globals.viewport?.value === 'mobile') {
          await userEvent.click(canvas.getByRole('button', { name: i18n.t('videos.detail.transcriptSection') }));
        }
        replay = await canvas.findByRole('button', { name: /00:00:05/ });
      } else {
        const input = await canvas.findByRole('textbox', { name: i18n.t('chat.placeholder') });
        await userEvent.type(input, 'Replay');
        await userEvent.keyboard('{Enter}');
        replay = await canvas.findByRole('button', { name: `${video.title} 00:00:05` });
        await waitFor(() => expect(input).toBeEnabled());
      }
      const player = () => canvasElement.querySelector('iframe');
      await expect(player()).toHaveAttribute('src', 'about:blank');
      for (let attempt = 0; attempt < 3; attempt++) {
        const previous = player();
        if (attempt === 1) {
          replay.focus();
          await userEvent.keyboard('{Enter}');
        } else {
          await userEvent.click(replay);
        }
        await waitFor(() => expect(player()).not.toBe(previous));
        await expect(player()).toHaveAttribute('src', 'about:blank?autoplay=1&start=5');
        await expect(previous).not.toBeInTheDocument();
        await expect(replay).toHaveFocus();
      }
      const current = player();
      const input = scope === 'video'
        ? canvas.getByRole('searchbox')
        : canvas.getByRole('textbox', { name: i18n.t('chat.placeholder') });
      await userEvent.type(input, 'a');
      await expect(player()).toBe(current);
    },
  };
}
export const YoutubeSubtitleReplay = youtubeReplayStory('video');
export const YoutubeSubtitleReplayEnglishMobile: Story = { ...YoutubeSubtitleReplay, globals: { locale: 'en', viewport: { value: 'mobile', isRotated: false } } };
export const YoutubeCourseCitationReplay = youtubeReplayStory('course');
export const YoutubeCourseCitationReplayEnglishMobile: Story = { ...YoutubeCourseCitationReplay, globals: { locale: 'en', viewport: { value: 'mobile', isRotated: false } } };
export const YoutubeSharedCitationReplay = youtubeReplayStory('share');
export const YoutubeSharedCitationReplayEnglishMobile: Story = { ...YoutubeSharedCitationReplay, globals: { locale: 'en', viewport: { value: 'mobile', isRotated: false } } };

export const InvitationNotice: Story = {
  parameters: {
    pathname: '/course-invitations/sample-invitation',
    api: {
      auth: authFixtures.loggedOut,
      trpc: [trpcQuery('courseMemberships.preview', success({
        course_id: course.id, course_name: course.name, inviter_name: 'Teacher',
        email_hint: 's*****t@example.com', status: 'pending', expires_at: '2026-10-01T00:00:00Z',
      }))],
    },
  },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(await canvas.findByText(i18n.t('courseSharing.invitation'))).toBeVisible();
    await expect(canvas.getByText(i18n.t('courseSharing.quotaAndHistory'))).toBeVisible();
    await expect(canvas.getByRole('link', { name: i18n.t('courseInvitation.login') })).toBeVisible();
  },
};
export const InvitationNoticeEnglishMobile: Story = {
  ...InvitationNotice,
  globals: { locale: 'en', viewport: { value: 'mobile', isRotated: false } },
};

const invitationRequests = { preview: fn(), accept: fn(), decline: fn() };
function invitationResponseStory(action: 'accept' | 'retry'): Story {
  return {
    parameters: {
      pathname: '/course-invitations/sample-invitation',
      api: { ...api, trpc: [
        ...api.trpc,
        trpcQuery('courses.get', success({ ...course, access_role: 'member' })),
        trpcQuery('courseMemberships.preview', input => {
          invitationRequests.preview(input);
          return success({ course_id: course.id, course_name: course.name, inviter_name: 'Teacher',
            email_hint: 's*****t@example.com', status: 'pending', expires_at: '2026-10-01T00:00:00Z' });
        }),
        trpcMutation('courseMemberships.accept', input => {
          invitationRequests.accept(input);
          return action === 'retry' ? failure('Accept failed (fixture)') : success({ course_id: course.id, status: 'accepted' });
        }),
        trpcMutation('courseMemberships.decline', input => {
          invitationRequests.decline(input);
          return invitationRequests.decline.mock.calls.length === 1 ? failure('Decline failed (fixture)') : success({ status: 'declined' });
        }),
      ] },
    },
    beforeEach() { Object.values(invitationRequests).forEach(request => request.mockClear()); },
    async play({ canvas, canvasElement, userEvent }) {
      const accept = await canvas.findByRole('button', { name: i18n.t('courseInvitation.accept') });
      accept.focus();
      await userEvent.keyboard('{Enter}');
      if (action === 'accept') {
        await expect(await canvas.findByRole('heading', { level: 1, name: course.name })).toBeVisible();
        await expect(invitationRequests.accept).toHaveBeenCalledWith({ token: 'sample-invitation' });
        await expect(invitationRequests.decline).not.toHaveBeenCalled();
      } else {
        await expect(await canvas.findByText('Accept failed (fixture)')).toBeVisible();
        await userEvent.click(canvas.getByRole('button', { name: i18n.t('courseInvitation.decline') }));
        await expect(await canvas.findByText('Decline failed (fixture)')).toBeVisible();
        await expect(canvas.queryByText('Accept failed (fixture)')).not.toBeInTheDocument();
        canvas.getByRole('button', { name: i18n.t('courseInvitation.decline') }).focus();
        await userEvent.keyboard('{Enter}');
        await expect(await canvas.findByText(i18n.t('courseInvitation.declined'))).toBeVisible();
        await expect(canvas.queryByText('Decline failed (fixture)')).not.toBeInTheDocument();
        await expect(invitationRequests.decline).toHaveBeenCalledTimes(2);
      }
      await expect(invitationRequests.preview).toHaveBeenCalledTimes(1);
      await expect(canvasElement.scrollWidth).toBeLessThanOrEqual(canvasElement.clientWidth);
    },
  };
}
export const InvitationAccept = invitationResponseStory('accept');
export const InvitationAcceptEnglishMobile: Story = { ...InvitationAccept, globals: { locale: 'en', viewport: { value: 'mobile', isRotated: false } } };
export const InvitationDecisionRetry = invitationResponseStory('retry');
export const InvitationDecisionRetryEnglishMobile: Story = { ...InvitationDecisionRetry, globals: { locale: 'en', viewport: { value: 'mobile', isRotated: false } } };

const videoEditRequests = { get: fn(), update: fn() };
function videoSaveStory(mode: 'metadata' | 'background' | 'transcript'): Story {
  const backgroundUpdate = mode === 'background';
  const savedTitle = mode === 'transcript' ? detailVideo.title : 'Saved video title';
  const savedDescription = backgroundUpdate ? 'Updated elsewhere' : detailVideo.description;
  const savedTranscript = '1\n00:00:00,000 --> 00:00:05,000\nSaved subtitle';
  return {
    parameters: {
      pathname: `/videos/${detailVideo.id}`,
      api: { ...api, trpc: [
        ...api.trpc,
        trpcQuery('videos.get', input => {
          videoEditRequests.get(input);
          return videoEditRequests.get.mock.calls.length === 1 ? success(detailVideo) : pending();
        }),
        trpcMutation('videos.update', input => {
          videoEditRequests.update(input);
          return success({ ...detailVideo, title: savedTitle, description: savedDescription,
            transcript: mode === 'transcript' ? savedTranscript : detailVideo.transcript });
        }),
      ] },
    },
    beforeEach() { Object.values(videoEditRequests).forEach(request => request.mockClear()); },
    async play({ canvas, canvasElement, userEvent, globals }) {
      await expect(await canvas.findByRole('heading', { level: 1, name: detailVideo.title })).toBeVisible();
      if (mode === 'transcript') {
        if (globals.viewport?.value === 'mobile') {
          await userEvent.click(canvas.getByRole('button', { name: i18n.t('videos.detail.transcriptSection') }));
        }
        const header = within(canvas.getByRole('heading', { name: i18n.t('videos.detail.transcriptSection') }).parentElement!.parentElement!);
        await userEvent.click(header.getByRole('button', { name: i18n.t('videos.detail.editTranscriptButton') }));
        const textbox = canvas.getByRole('textbox', { name: i18n.t('videos.detail.transcriptSection') });
        await userEvent.clear(textbox);
        await userEvent.type(textbox, savedTranscript);
        canvas.getByRole('button', { name: i18n.t('videos.detail.saveTranscriptButton') }).focus();
        await userEvent.keyboard('{Enter}');
        await waitFor(() => expect(canvas.queryByRole('textbox')).not.toBeInTheDocument());
        await expect(canvas.getByRole('button', { name: /Saved subtitle/ })).toBeVisible();
        await expect(header.getByRole('button', { name: i18n.t('videos.detail.editTranscriptButton') })).toHaveFocus();
        await expect(videoEditRequests.update).toHaveBeenCalledWith({ id: detailVideo.id, transcript: savedTranscript });
      } else {
        const actions = within(canvas.getByRole('button', { name: i18n.t('videos.detail.deleteButton') }).parentElement!);
        const edit = actions.getByRole('button', { name: i18n.t('videos.detail.editButton') });
        await userEvent.click(edit);
        const dialog = within(canvas.getByRole('dialog'));
        const title = dialog.getByRole('textbox', { name: i18n.t('videos.detail.editTitleLabel') });
        await userEvent.clear(title);
        await userEvent.type(title, 'Client title');
        if (backgroundUpdate) {
          appQueryClient.setQueryData(trpc.videos.get.queryKey({ id: detailVideo.id }), { ...detailVideo, description: savedDescription });
          await waitFor(() => expect(dialog.getByRole('textbox', { name: i18n.t('videos.detail.editDescriptionLabel') })).toHaveValue(savedDescription));
        }
        dialog.getByRole('button', { name: i18n.t('common.actions.save') }).focus();
        await userEvent.keyboard('{Enter}');
        await waitFor(() => expect(canvas.queryByRole('dialog')).not.toBeInTheDocument());
        await expect(canvas.getByRole('heading', { level: 1, name: savedTitle })).toBeVisible();
        await expect(videoEditRequests.update).toHaveBeenCalledWith({ id: detailVideo.id, title: 'Client title' });
        await expect(edit).toHaveFocus();
      }
      await expect(videoEditRequests.update).toHaveBeenCalledTimes(1);
      await expect(videoEditRequests.get).toHaveBeenCalledTimes(1);
      await expect(canvasElement.scrollWidth).toBeLessThanOrEqual(canvasElement.clientWidth);
    },
  };
}
export const VideoMetadataSave = videoSaveStory('metadata');
export const VideoMetadataSaveEnglishMobile: Story = { ...VideoMetadataSave, globals: { locale: 'en', viewport: { value: 'mobile', isRotated: false } } };
export const VideoMetadataBackgroundUpdate = videoSaveStory('background');
export const VideoMetadataBackgroundUpdateEnglishMobile: Story = { ...VideoMetadataBackgroundUpdate, globals: { locale: 'en', viewport: { value: 'mobile', isRotated: false } } };
export const VideoTranscriptSave = videoSaveStory('transcript');
export const VideoTranscriptSaveEnglishMobile: Story = { ...VideoTranscriptSave, globals: { locale: 'en', viewport: { value: 'mobile', isRotated: false } } };

const courseEditRequests = { get: fn(), update: fn() };
function courseMetadataStory(field: 'name' | 'description'): Story {
  const other = field === 'name' ? 'description' : 'name';
  const editedValue = field === 'name' ? 'My course name' : '';
  const current = { ...course, updated_at: course.created_at, [field]: 'Concurrent edit', [other]: 'Updated elsewhere' };
  return {
    parameters: {
      pathname: `/videos/courses/${course.id}`,
      api: { ...api, trpc: [
        ...api.trpc,
        trpcQuery('courses.get', input => {
          courseEditRequests.get(input);
          return courseEditRequests.get.mock.calls.length === 1 ? success(course) : pending();
        }),
        trpcMutation('courses.update', input => {
          courseEditRequests.update(input);
          return success({ ...current, [field]: editedValue });
        }),
      ] },
    },
    beforeEach() { Object.values(courseEditRequests).forEach(request => request.mockClear()); },
    async play({ canvas, canvasElement, userEvent }) {
      await userEvent.click(await canvas.findByLabelText(i18n.t('videos.courseDetail.manage')));
      const edit = await canvas.findByRole('button', { name: i18n.t('videos.courseDetail.editTitle') });
      await userEvent.click(edit);
      const dialog = within(canvas.getByRole('dialog'));
      const input = dialog.getByRole('textbox', { name: i18n.t(`videos.courses.${field}Label`) });
      await userEvent.clear(input);
      if (editedValue) await userEvent.type(input, editedValue);
      appQueryClient.setQueryData(trpc.courses.get.queryKey({ id: course.id }), current);
      await waitFor(() => expect(dialog.getByRole('textbox', { name: i18n.t(`videos.courses.${other}Label`) })).toHaveValue('Updated elsewhere'));
      await expect(input).toHaveValue(editedValue);
      dialog.getByRole('button', { name: i18n.t('common.actions.save') }).focus();
      await userEvent.keyboard('{Enter}');
      await waitFor(() => expect(canvas.queryByRole('dialog')).not.toBeInTheDocument());
      await expect(courseEditRequests.update).toHaveBeenCalledWith({ id: course.id, [field]: editedValue });
      await expect(courseEditRequests.update).toHaveBeenCalledTimes(1);
      await expect(courseEditRequests.get).toHaveBeenCalledTimes(1);
      await expect(edit).toHaveFocus();
      await userEvent.click(edit);
      const reopened = within(canvas.getByRole('dialog'));
      await expect(reopened.getByRole('textbox', { name: i18n.t(`videos.courses.${field}Label`) })).toHaveValue(editedValue);
      await expect(reopened.getByRole('textbox', { name: i18n.t(`videos.courses.${other}Label`) })).toHaveValue('Updated elsewhere');
      await userEvent.click(reopened.getByRole('button', { name: i18n.t('common.actions.save') }));
      await waitFor(() => expect(canvas.queryByRole('dialog')).not.toBeInTheDocument());
      await expect(courseEditRequests.update).toHaveBeenCalledTimes(1);
      await expect(courseEditRequests.get).toHaveBeenCalledTimes(1);
      await expect(canvasElement.scrollWidth).toBeLessThanOrEqual(canvasElement.clientWidth);
    },
  };
}
export const CourseMetadataBackgroundUpdate = courseMetadataStory('name');
export const CourseMetadataBackgroundUpdateEnglishMobile: Story = { ...CourseMetadataBackgroundUpdate, globals: { locale: 'en', viewport: { value: 'mobile', isRotated: false } } };
export const CourseMetadataClearDescription = courseMetadataStory('description');
export const CourseMetadataClearDescriptionEnglishMobile: Story = { ...CourseMetadataClearDescription, globals: { locale: 'en', viewport: { value: 'mobile', isRotated: false } } };

export const CourseDialogsClose: Story = {
  parameters: {
    pathname: `/videos/courses/${course.id}`,
    api: { ...api, trpc: [...api.trpc,
      trpcQuery('courses.get', success(course)),
    ] },
  },
  async play({ canvas, userEvent }) {
    await userEvent.click(await canvas.findByLabelText(i18n.t('videos.courseDetail.manage')));
    const edit = await canvas.findByRole('button', { name: i18n.t('videos.courseDetail.editTitle') });
    await userEvent.click(edit);
    await userEvent.click(within(canvas.getByRole('dialog')).getByRole('button', { name: i18n.t('common.actions.cancel') }));
    await waitFor(() => expect(canvas.queryByRole('dialog')).not.toBeInTheDocument());
    await expect(edit).toHaveFocus();

    const share = canvas.getByRole('button', { name: i18n.t('videos.courseDetail.shareOpen') });
    for (const closeWith of ['button', 'escape']) {
      await userEvent.click(share);
      if (closeWith === 'button') {
        await userEvent.click(within(canvas.getByRole('dialog')).getByRole('button', { name: i18n.t('common.actions.close') }));
      } else {
        // Synthetic key events do not trigger the native dialog's default cancel action.
        canvas.getByRole('dialog').dispatchEvent(new Event('cancel', { cancelable: true }));
      }
      await waitFor(() => expect(canvas.queryByRole('dialog')).not.toBeInTheDocument());
      await expect(share).toHaveFocus();
    }
  },
};
export const CourseDialogsCloseEnglishMobile: Story = { ...CourseDialogsClose, globals: { locale: 'en', viewport: { value: 'mobile', isRotated: false } } };

export const HomeNavigation: Story = {
  async play({ canvasElement, userEvent, globals }) {
    const canvas = within(canvasElement);
    await canvas.findByRole('heading', { level: 1, name: i18n.t('pricing.title') });
    const header = canvas.getByRole('link', { name: 'VideoQ' }).closest('header')!;
    const footer = canvas.getByRole('contentinfo');
    const main = canvas.getByRole('main');
    const mobile = globals.viewport?.value === 'mobile';
    if (mobile) {
      const trigger = within(header).getByRole('button', { name: i18n.t('navigation.menu') });
      trigger.focus();
      await userEvent.keyboard('{Enter}');
    }
    await userEvent.click(within(header).getByRole('link', { name: i18n.t('navigation.home') }));
    await canvas.findByRole('heading', { level: 1, name: i18n.t('home.welcome.greeting', { username: api.auth.profile!.username }) });
    await expect(canvas.getByRole('link', { name: 'VideoQ' }).closest('header')).toBe(header);
    await expect(canvas.getByRole('contentinfo')).toBe(footer);
    await expect(canvas.getByRole('main')).toBe(main);
    if (mobile) await userEvent.click(within(header).getByRole('button', { name: i18n.t('navigation.menu') }));
    await expect(within(header).getByRole('link', { name: i18n.t('navigation.home') })).toHaveAttribute('aria-current', 'page');
  },
};
export const HomeNavigationMobile: Story = {
  ...HomeNavigation,
  globals: { viewport: { value: 'mobile', isRotated: false } },
};
export const HomeNavigationEnglish: Story = { ...HomeNavigation, globals: { locale: 'en' } };
export const HomeNavigationEnglishMobile: Story = {
  ...HomeNavigation,
  globals: { locale: 'en', viewport: { value: 'mobile', isRotated: false } },
};

export const CoursesCaseInsensitive: Story = {
  parameters: { pathname: '/videos/COURSES' },
  async play({ canvasElement, userEvent, globals }) {
    const canvas = within(canvasElement);
    const heading = await canvas.findByRole('heading', { level: 1, name: i18n.t('videos.courses.title') });
    const header = canvas.getByRole('link', { name: 'VideoQ' }).closest('header')!;
    const main = canvas.getByRole('main');
    const footer = canvas.getByRole('contentinfo');
    await expect(heading.getBoundingClientRect().left).toBeGreaterThan(0);
    if (globals.viewport?.value === 'mobile') {
      await userEvent.click(within(header).getByRole('button', { name: i18n.t('navigation.menu') }));
    }
    await expect(within(header).getByRole('link', { name: i18n.t('navigation.coursesNav') })).toHaveAttribute('aria-current', 'page');
    await userEvent.click(within(header).getByRole('link', { name: i18n.t('navigation.home') }));
    await canvas.findByRole('heading', { level: 1, name: i18n.t('home.welcome.greeting', { username: api.auth.profile!.username }) });
    await expect(canvas.getByRole('link', { name: 'VideoQ' }).closest('header')).toBe(header);
    await expect(canvas.getByRole('main')).toBe(main);
    await expect(canvas.getByRole('contentinfo')).toBe(footer);
  },
};
export const CoursesCaseInsensitiveEnglishMobile: Story = {
  ...CoursesCaseInsensitive,
  globals: { locale: 'en', viewport: { value: 'mobile', isRotated: false } },
};

let failCourseList = true;
let courseListRequests = 0;
export const CoursesRetry: Story = {
  parameters: {
    pathname: '/videos/courses',
    api: { ...api, trpc: api.trpc.map((mock) => mock.path === 'courses.list'
      ? trpcQuery('courses.list', () => {
        courseListRequests++;
        return failCourseList
          ? failure('Course list unavailable')
          : success({ data: [{ ...course, access_role: 'owner' as const }], meta: { total: 1, limit: 24, offset: 0 } });
      })
      : mock) },
  },
  beforeEach() { failCourseList = true; courseListRequests = 0; },
  async play({ canvasElement, userEvent }) {
    const canvas = within(canvasElement);
    await expect(await canvas.findByText('Course list unavailable')).toBeVisible();
    await expect(canvas.queryByText(i18n.t('videos.courses.empty'))).not.toBeInTheDocument();
    const retry = canvas.getByRole('button', { name: i18n.t('videos.courses.retryLoad') });
    retry.focus();
    failCourseList = false;
    await userEvent.keyboard('{Enter}');
    await expect(await canvas.findByText(course.name)).toBeVisible();
    await expect(canvas.queryByText('Course list unavailable')).not.toBeInTheDocument();
    await expect(retry).not.toBeInTheDocument();
    await expect(courseListRequests).toBe(2);
    const main = canvas.getByRole('main');
    await expect(main.scrollWidth).toBeLessThanOrEqual(main.clientWidth);
  },
};
export const CoursesRetryEnglishMobile: Story = {
  ...CoursesRetry,
  globals: { locale: 'en', viewport: { value: 'mobile', isRotated: false } },
};

export const HomeDataPending: Story = {
  parameters: { api: { ...api, trpc: api.trpc.map((mock) => mock.path === 'videos.list' ? trpcQuery('videos.list', pending()) : mock) } },
  async play({ canvasElement, userEvent }) {
    const canvas = within(canvasElement);
    await canvas.findByRole('heading', { level: 1, name: i18n.t('pricing.title') });
    const header = canvas.getByRole('link', { name: 'VideoQ' }).closest('header')!;
    const footer = canvas.getByRole('contentinfo');
    await userEvent.click(within(header).getByRole('link', { name: i18n.t('navigation.home') }));
    await within(canvas.getByRole('main')).findByText(i18n.t('common.messages.loading'));
    const trigger = within(header).getByRole('button', { name: i18n.t('navigation.menu') });
    await userEvent.click(trigger);
    await expect(trigger).toHaveAttribute('aria-expanded', 'true');
    await expect(header).toBeVisible();
    await expect(canvas.getByRole('contentinfo')).toBe(footer);
  },
};

export const LeavePendingHome: Story = {
  ...HomeDataPending,
  async play(context) {
    await HomeDataPending.play!(context);
    const { canvasElement, userEvent } = context;
    const canvas = within(canvasElement);
    const header = canvas.getByRole('link', { name: 'VideoQ' }).closest('header')!;
    // Close the menu and navigate using the desktop link.
    await userEvent.click(within(header).getByRole('button', { name: i18n.t('navigation.closeMenu'), expanded: true }));
    await userEvent.click(within(header).getByRole('link', { name: i18n.t('navigation.pricing') }));
    await canvas.findByRole('heading', { level: 1, name: i18n.t('pricing.title') });
    await expect(header).toBeVisible();
    await expect(within(header).getByRole('link', { name: i18n.t('navigation.pricing') })).toHaveAttribute('aria-current', 'page');
  },
};

export const FailedLibrary: Story = {
  parameters: {
    pathname: '/videos',
    api: { ...api, trpc: api.trpc.map((mock) => mock.path === 'videos.list' ? trpcQuery('videos.list', failure('動画の取得に失敗しました')) : mock) },
  },
  async play({ canvasElement, userEvent }) {
    const canvas = within(canvasElement);
    await canvas.findByText('動画の取得に失敗しました');
    const header = canvas.getByRole('link', { name: 'VideoQ' }).closest('header')!;
    await userEvent.click(within(header).getByRole('link', { name: i18n.t('navigation.pricing') }));
    await canvas.findByRole('heading', { level: 1, name: i18n.t('pricing.title') });
    await expect(header).toBeVisible();
  },
};

export const AuthNavigation: Story = {
  parameters: { pathname: '/login', api: { ...api, auth: authFixtures.loggedOut } },
  async play({ canvasElement, userEvent }) {
    const canvas = within(canvasElement);
    await canvas.findByRole('heading', { level: 1, name: i18n.t('auth.login.title') });
    const header = canvas.getByRole('banner');
    const main = canvas.getByRole('main');
    await userEvent.click(canvas.getByRole('link', { name: i18n.t('auth.login.footerLink') }));
    await canvas.findByRole('heading', { level: 1, name: i18n.t('auth.signup.title') });
    await expect(canvas.getByRole('banner')).toBe(header);
    await expect(canvas.getByRole('main')).toBe(main);
    await waitFor(() => expect(canvas.queryByRole('navigation', { name: i18n.t('navigation.menu') })).not.toBeInTheDocument());
  },
};

export const PendingVideo: Story = {
  parameters: {
    pathname: '/videos/7',
    api: { ...api, trpc: [...api.trpc, trpcQuery('videos.get', pending())] },
  },
  async beforeEach() {
    // Model an authenticated visitor before holding the content request open.
    // Otherwise a warm route can batch account.me with the pending fixture.
    await appQueryClient.fetchQuery(trpc.account.me.queryOptions());
  },
  async play({ canvasElement, userEvent }) {
    const canvas = within(canvasElement);
    const header = canvas.getByRole('link', { name: 'VideoQ' }).closest('header')!;
    await within(canvas.getByRole('main')).findByText(i18n.t('common.messages.loading'));
    await expect(canvas.queryByRole('contentinfo')).not.toBeInTheDocument();
    await userEvent.click(within(header).getByRole('link', { name: i18n.t('navigation.home') }));
    await canvas.findByRole('heading', { level: 1, name: i18n.t('home.welcome.greeting', { username: api.auth.profile!.username }) });
    await expect(header).toBeVisible();
    await expect(canvas.getByRole('contentinfo')).toBeInTheDocument();
  },
};
export const PendingCourse: Story = {
  beforeEach: PendingVideo.beforeEach,
  parameters: {
    pathname: '/videos/courses/7',
    api: { ...api, trpc: [...api.trpc, trpcQuery('courses.get', pending())] },
  },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await canvas.findByText(i18n.t('common.messages.loading'));
    await expect(canvas.queryByRole('button', { name: i18n.t('navigation.menu') })).not.toBeInTheDocument();
    await expect(canvas.queryByRole('contentinfo')).not.toBeInTheDocument();
  },
};

export const VideoMobileLayout: Story = {
  globals: { viewport: { value: 'mobile', isRotated: false } },
  parameters: {
    pathname: '/videos/7',
    api: { ...api, trpc: [...api.trpc, trpcQuery('videos.get', success({ ...detailVideo, status: 'processing' }))] },
  },
  async play({ canvasElement, userEvent }) {
    const canvas = within(canvasElement);
    const transcriptTab = await canvas.findByRole('button', { name: i18n.t('videos.detail.transcriptSection') });
    const tabs = transcriptTab.parentElement!;
    const header = canvas.getByRole('link', { name: 'VideoQ' }).closest('header')!;
    await expect(tabs.getBoundingClientRect().left).toBe(0);
    await expect(tabs.getBoundingClientRect().width).toBe(canvasElement.ownerDocument.documentElement.clientWidth);
    await expect(tabs.getBoundingClientRect().top).toBe(header.getBoundingClientRect().bottom);
    await userEvent.click(transcriptTab);
    await expect(header).toBeVisible();
    await expect(canvas.getAllByRole('main')).toHaveLength(1);
    await expect(canvas.queryByRole('contentinfo')).not.toBeInTheDocument();
  },
};

export const EncodedLocaleVideoMobile: Story = {
  ...VideoMobileLayout,
  // Start in Japanese; the encoded URL must select English before rendering the page.
  globals: { locale: 'ja', viewport: { value: 'mobile', isRotated: false } },
  parameters: { ...VideoMobileLayout.parameters, pathname: '/%65n/videos/7' },
  async play(context) {
    await VideoMobileLayout.play!(context);
    const canvas = within(context.canvasElement);
    const header = canvas.getByRole('link', { name: 'VideoQ' }).closest('header')!;
    const main = canvas.getByRole('main');
    await expect(i18n.language).toBe('en');
    await context.userEvent.click(within(header).getByRole('button', { name: i18n.t('navigation.menu') }));
    await expect(within(header).getByRole('link', { name: i18n.t('navigation.videoLibrary') })).toHaveAttribute('aria-current', 'page');
    await context.userEvent.click(within(header).getByRole('link', { name: i18n.t('navigation.home') }));
    await canvas.findByRole('heading', { level: 1, name: i18n.t('home.welcome.greeting', { username: api.auth.profile!.username }) });
    await expect(canvas.getByRole('link', { name: 'VideoQ' }).closest('header')).toBe(header);
    await expect(canvas.getByRole('main')).toBe(main);
    await expect(canvas.getByRole('contentinfo')).toBeInTheDocument();
  },
};

export const LoggedOutHome: Story = {
  parameters: { pathname: '/', api: { ...api, auth: authFixtures.loggedOut } },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    const heading = await canvas.findByRole('heading', { level: 1 });
    await expect(heading).toHaveTextContent(i18n.t('landing.title'));
    await expect(heading).toHaveTextContent(i18n.t('landing.titleAccent'));
    await expect(canvas.getAllByRole('main')).toHaveLength(1);
    await expect(canvas.getAllByRole('contentinfo')).toHaveLength(1);
  },
};

export const LandingWhileSessionPending: Story = {
  ...LoggedOutHome,
  beforeEach() {
    mocked(useAuthSession).mockReturnValue({
      data: null, error: null, isPending: true, isRefetching: false,
      refetch: fn(async () => undefined),
    });
  },
  async play(context) {
    const canvas = within(context.canvasElement);
    await expect(canvas.getByRole('heading', { level: 1 })).toHaveTextContent(i18n.t('landing.title'));
    await expect(canvas.queryByText(i18n.t('common.messages.loading'))).not.toBeInTheDocument();
    await LoggedOutHome.play!(context);
  },
};

export const LandingWhileSessionPendingEnglishMobile: Story = {
  ...LandingWhileSessionPending,
  globals: { locale: 'en', viewport: { value: 'mobile', isRotated: false } },
};
