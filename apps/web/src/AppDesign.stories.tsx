import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, waitFor, within } from 'storybook/test';
import { http, HttpResponse } from 'msw';
import App from './App';
import i18n from './i18n/config';
import { authFixtures } from '../.storybook/fixtures/auth';
import { detailVideo, course, libraryVideos } from '../.storybook/fixtures/detail';
import { consents } from '../.storybook/fixtures/connectedApps';
import { tagPage, integrationApiKeys } from '../.storybook/fixtures/api';
import { success, trpcQuery } from '../.storybook/mocks/network';
import { installUploadFixture } from '../.storybook/mocks/videoUpload';
import { landingMedia } from '../.storybook/mocks/landingMedia';
import { GUIDE_CATALOG } from './lib/guideCatalog';

// Full router + shells, rather than isolated page fragments. This catalog covers
// every route family in Japanese desktop/mobile and English mobile.
const page = <T,>(data: T[]) => ({ data, meta: { total: data.length, offset: 0, limit: 24 } });
const common = [
  trpcQuery('billing.plans', success([{ code: 'free', interval: null, lookup_key: null, unit_amount: 0, currency: 'jpy', entitlements: { max_video_upload_size_mb: 200, storage_limit_gb: 1, monthly_upload_limit_gb: 2, processing_limit_minutes: 45, ai_answers_limit: 30 } }])),
  trpcQuery('videos.list', success(page(libraryVideos))),
  trpcQuery('courses.list', success(page([{ ...course, access_role: 'owner' as const }]))),
  trpcQuery('tags.list', success(tagPage)),
  trpcQuery('videos.statusCounts', success({ total: 4, completed: 3, processing: 1, pending: 0, indexing: 0, error: 0, uploading: 0 })),
  trpcQuery('videos.get', success(detailVideo)),
  trpcQuery('courses.get', success(course)),
  trpcQuery('chat.history', success(page([]))),
  trpcQuery('courses.shared', success({ ...course, updated_at: course.created_at, share_slug: 'design-preview', access_role: 'public' })),
  trpcQuery('courseMemberships.preview', success({ course_id: course.id, course_name: course.name, inviter_name: 'Teacher', email_hint: 's*****t@example.com', status: 'pending', expires_at: '2099-01-01T00:00:00Z' })),
  trpcQuery('account.searchApiKeyStatus', success({ has_api_key: false })),
  trpcQuery('account.integrationApiKeys', success(integrationApiKeys)),
  trpcQuery('account.connectedApps', success(consents)),
  trpcQuery('admin.listUsers', success(page([{
    id: 'design-user-7c1984d2', username: '山田 太郎', email: 'learner@example.test', is_active: true, is_admin: false,
    max_video_upload_size_mb: 200, storage_limit_gb: 1, monthly_upload_limit_gb: 2, processing_limit_minutes: 45, ai_answers_limit: 30,
    used_storage_bytes: 0, used_processing_seconds: 0, used_ai_answers: 0, usage_period_start: null,
    is_over_quota: false, plan_code: 'free', quota_source: 'plan',
  }]))),
];
const meta = {
  title: 'Application/Design coverage', component: App,
  parameters: { layout: 'fullscreen', api: { auth: authFixtures.user, trpc: common, rest: [
    http.get('/api/lms/pairing', () => HttpResponse.json({ connections: [] })),
    http.post('/api/lms/pairing/management', () => HttpResponse.json({ connection: { owned: true, active: true }, permissions: { account: true, billing: true, systemAdmin: false } })),
    landingMedia,
    http.get('/api/auth/verify-email', () => HttpResponse.json({ status: true })),
  ] } },
  globals: { viewport: { value: 'desktop', isRotated: false } },
  beforeEach() { return installUploadFixture({}); },
  async play({ canvasElement, parameters }) {
    await waitFor(() => expect(canvasElement.querySelector('main')).toBeInTheDocument());
    await waitFor(() => expect(canvasElement.querySelector('h1')).toBeInTheDocument());
    const doc = canvasElement.ownerDocument;
    const win = doc.defaultView!;
    const bodyStyle = win.getComputedStyle(doc.body);
    await expect(bodyStyle.fontSize).toBe('17px');
    await expect(bodyStyle.lineHeight).toBe('28.9px');
    // Canonical tokens must not be replaced by a page or a logged-in shell.
    await expect(bodyStyle.getPropertyValue('--color-key-900').trim()).toBe('#0017c1');
    await expect(bodyStyle.getPropertyValue('--color-solid-gray-800').trim()).toBe('#333333');
    await waitFor(() => expect(doc.documentElement.scrollWidth).toBeLessThanOrEqual(win.innerWidth));
    const title = canvasElement.querySelector('main h1');
    if (title && !parameters.compactTitle) {
      await expect(win.getComputedStyle(title).fontSize).toBe(win.innerWidth < 768 ? '28px' : '45px');
    }
    // Exclude loading placeholders: exercise real content for authenticated routes.
    await expect(canvasElement.querySelector('main')!.textContent.trim().length).toBeGreaterThan(10);
  },
} satisfies Meta<typeof App>;
export default meta;
type Story = StoryObj<typeof meta>;
const guest = { api: { auth: authFixtures.loggedOut } };
const compact = { compactTitle: true };

export const Home: Story = { parameters: { pathname: '/' } };
export const HomeMobile: Story = { ...Home, globals: { viewport: { value: 'mobile', isRotated: false } } };
export const HomeEnglishMobile: Story = { ...Home, globals: { locale: 'en', viewport: { value: 'mobile', isRotated: false } } };

export const Library: Story = { parameters: { pathname: '/videos' } };
export const LibraryMobile: Story = { ...Library, globals: { viewport: { value: 'mobile', isRotated: false } } };
export const LibraryEnglishMobile: Story = { ...Library, globals: { locale: 'en', viewport: { value: 'mobile', isRotated: false } } };

export const Courses: Story = { parameters: { pathname: '/videos/courses' } };
export const CoursesMobile: Story = { ...Courses, globals: { viewport: { value: 'mobile', isRotated: false } } };
export const CoursesEnglishMobile: Story = { ...Courses, globals: { locale: 'en', viewport: { value: 'mobile', isRotated: false } } };

export const Video: Story = { parameters: { pathname: '/videos/7', ...compact } };
export const VideoMobile: Story = { ...Video, globals: { viewport: { value: 'mobile', isRotated: false } } };
export const VideoEnglishMobile: Story = { ...Video, globals: { locale: 'en', viewport: { value: 'mobile', isRotated: false } } };

export const Course: Story = { parameters: { pathname: '/videos/courses/42', ...compact } };
export const CourseMobile: Story = { ...Course, globals: { viewport: { value: 'mobile', isRotated: false } } };
export const CourseEnglishMobile: Story = { ...Course, globals: { locale: 'en', viewport: { value: 'mobile', isRotated: false } } };

export const Settings: Story = { parameters: { pathname: '/settings' } };
export const SettingsMobile: Story = { ...Settings, globals: { viewport: { value: 'mobile', isRotated: false } } };
export const SettingsEnglishMobile: Story = { ...Settings, globals: { locale: 'en', viewport: { value: 'mobile', isRotated: false } } };

export const Admin: Story = { parameters: { pathname: '/admin', ...{ api: { auth: authFixtures.admin } } } };
export const AdminMobile: Story = { ...Admin, globals: { viewport: { value: 'mobile', isRotated: false } } };
export const AdminEnglishMobile: Story = { ...Admin, globals: { locale: 'en', viewport: { value: 'mobile', isRotated: false } } };

export const Landing: Story = { parameters: { pathname: '/', ...{ ...guest, ...compact } } };
export const LandingMobile: Story = { ...Landing, globals: { viewport: { value: 'mobile', isRotated: false } } };
export const LandingEnglishMobile: Story = { ...Landing, globals: { locale: 'en', viewport: { value: 'mobile', isRotated: false } } };

export const Login: Story = { parameters: { pathname: '/login', ...guest } };
export const LoginMobile: Story = { ...Login, globals: { viewport: { value: 'mobile', isRotated: false } } };
export const LoginEnglishMobile: Story = { ...Login, globals: { locale: 'en', viewport: { value: 'mobile', isRotated: false } } };

export const Signup: Story = { parameters: { pathname: '/signup', ...guest } };
export const SignupMobile: Story = { ...Signup, globals: { viewport: { value: 'mobile', isRotated: false } } };
export const SignupEnglishMobile: Story = { ...Signup, globals: { locale: 'en', viewport: { value: 'mobile', isRotated: false } } };

export const ForgotPassword: Story = { parameters: { pathname: '/forgot-password', ...guest } };
export const ForgotPasswordMobile: Story = { ...ForgotPassword, globals: { viewport: { value: 'mobile', isRotated: false } } };
export const ForgotPasswordEnglishMobile: Story = { ...ForgotPassword, globals: { locale: 'en', viewport: { value: 'mobile', isRotated: false } } };

export const ResetPassword: Story = { parameters: { pathname: '/reset-password?token=design-preview', ...guest } };
export const ResetPasswordMobile: Story = { ...ResetPassword, globals: { viewport: { value: 'mobile', isRotated: false } } };
export const ResetPasswordEnglishMobile: Story = { ...ResetPassword, globals: { locale: 'en', viewport: { value: 'mobile', isRotated: false } } };

export const CheckEmail: Story = { parameters: { pathname: '/signup/check-email', ...guest } };
export const CheckEmailMobile: Story = { ...CheckEmail, globals: { viewport: { value: 'mobile', isRotated: false } } };
export const CheckEmailEnglishMobile: Story = { ...CheckEmail, globals: { locale: 'en', viewport: { value: 'mobile', isRotated: false } } };

export const SignupCallbackError: Story = { parameters: { pathname: '/signup/complete?error=callback', ...{ ...guest, ...compact } } };
export const SignupCallbackErrorMobile: Story = { ...SignupCallbackError, globals: { viewport: { value: 'mobile', isRotated: false } } };
export const SignupCallbackErrorEnglishMobile: Story = { ...SignupCallbackError, globals: { locale: 'en', viewport: { value: 'mobile', isRotated: false } } };

export const SignupVerificationError: Story = { parameters: { pathname: '/signup/verified?error=verification', ...{ ...guest, ...compact } } };
export const SignupVerificationErrorMobile: Story = { ...SignupVerificationError, globals: { viewport: { value: 'mobile', isRotated: false } } };
export const SignupVerificationErrorEnglishMobile: Story = { ...SignupVerificationError, globals: { locale: 'en', viewport: { value: 'mobile', isRotated: false } } };

export const VerifyEmail: Story = { parameters: { pathname: '/verify-email?error=invalid', ...guest } };
export const VerifyEmailMobile: Story = { ...VerifyEmail, globals: { viewport: { value: 'mobile', isRotated: false } } };
export const VerifyEmailEnglishMobile: Story = { ...VerifyEmail, globals: { locale: 'en', viewport: { value: 'mobile', isRotated: false } } };

export const EmailChange: Story = { parameters: { pathname: '/change-email?step=verify-new', ...guest } };
export const EmailChangeMobile: Story = { ...EmailChange, globals: { viewport: { value: 'mobile', isRotated: false } } };
export const EmailChangeEnglishMobile: Story = { ...EmailChange, globals: { locale: 'en', viewport: { value: 'mobile', isRotated: false } } };

export const Consent: Story = { parameters: { pathname: '/consent?client_name=LMS&scope=videoq.read' } };
export const ConsentMobile: Story = { ...Consent, globals: { viewport: { value: 'mobile', isRotated: false } } };
export const ConsentEnglishMobile: Story = { ...Consent, globals: { locale: 'en', viewport: { value: 'mobile', isRotated: false } } };

export const MoodleConnect: Story = { parameters: { pathname: '/moodle/connect?moodle_url=https%3A%2F%2Fmoodle.example&state=' + 'a'.repeat(64) + '&code_challenge=' + 'b'.repeat(43) } };
export const MoodleConnectMobile: Story = { ...MoodleConnect, globals: { viewport: { value: 'mobile', isRotated: false } } };
export const MoodleConnectEnglishMobile: Story = { ...MoodleConnect, globals: { locale: 'en', viewport: { value: 'mobile', isRotated: false } } };

export const MoodleManage: Story = { parameters: { pathname: '/moodle/manage?issuer=https%3A%2F%2Fmoodle.example&clientId=design&deploymentId=23' } };
export const MoodleManageMobile: Story = { ...MoodleManage, globals: { viewport: { value: 'mobile', isRotated: false } } };
export const MoodleManageEnglishMobile: Story = { ...MoodleManage, globals: { locale: 'en', viewport: { value: 'mobile', isRotated: false } } };

export const Invitation: Story = { parameters: { pathname: '/course-invitations/design-preview' } };
export const InvitationMobile: Story = { ...Invitation, globals: { viewport: { value: 'mobile', isRotated: false } } };
export const InvitationEnglishMobile: Story = { ...Invitation, globals: { locale: 'en', viewport: { value: 'mobile', isRotated: false } } };

export const SharedCourse: Story = { parameters: { pathname: '/share/design-preview', ...{ ...guest, ...compact } } };
export const SharedCourseMobile: Story = { ...SharedCourse, globals: { viewport: { value: 'mobile', isRotated: false } } };
export const SharedCourseEnglishMobile: Story = { ...SharedCourse, globals: { locale: 'en', viewport: { value: 'mobile', isRotated: false } } };

export const Try: Story = { parameters: { pathname: '/try', ...{ ...guest, ...compact } } };
export const TryMobile: Story = { ...Try, globals: { viewport: { value: 'mobile', isRotated: false } } };
export const TryEnglishMobile: Story = { ...Try, globals: { locale: 'en', viewport: { value: 'mobile', isRotated: false } } };

export const Pricing: Story = { parameters: { pathname: '/pricing', ...guest } };
export const PricingMobile: Story = { ...Pricing, globals: { viewport: { value: 'mobile', isRotated: false } } };
export const PricingEnglishMobile: Story = { ...Pricing, globals: { locale: 'en', viewport: { value: 'mobile', isRotated: false } } };

export const Guides: Story = { parameters: { pathname: '/guides', ...guest } };
export const GuidesMobile: Story = { ...Guides, globals: { viewport: { value: 'mobile', isRotated: false } } };
export const GuidesEnglishMobile: Story = { ...Guides, globals: { locale: 'en', viewport: { value: 'mobile', isRotated: false } } };

export const GuideArticle: Story = { parameters: { pathname: '/guides/' + GUIDE_CATALOG[0].slug, ...guest } };
export const GuideArticleMobile: Story = { ...GuideArticle, globals: { viewport: { value: 'mobile', isRotated: false } } };
export const GuideArticleEnglishMobile: Story = { ...GuideArticle, globals: { locale: 'en', viewport: { value: 'mobile', isRotated: false } } };

export const Terms: Story = { parameters: { pathname: '/terms', ...guest } };
export const TermsMobile: Story = { ...Terms, globals: { viewport: { value: 'mobile', isRotated: false } } };
export const TermsEnglishMobile: Story = { ...Terms, globals: { locale: 'en', viewport: { value: 'mobile', isRotated: false } } };

export const Privacy: Story = { parameters: { pathname: '/privacy', ...guest } };
export const PrivacyMobile: Story = { ...Privacy, globals: { viewport: { value: 'mobile', isRotated: false } } };
export const PrivacyEnglishMobile: Story = { ...Privacy, globals: { locale: 'en', viewport: { value: 'mobile', isRotated: false } } };

export const Refund: Story = { parameters: { pathname: '/refund', ...guest } };
export const RefundMobile: Story = { ...Refund, globals: { viewport: { value: 'mobile', isRotated: false } } };
export const RefundEnglishMobile: Story = { ...Refund, globals: { locale: 'en', viewport: { value: 'mobile', isRotated: false } } };

export const Legal: Story = { parameters: { pathname: '/legal', ...guest } };
export const LegalMobile: Story = { ...Legal, globals: { viewport: { value: 'mobile', isRotated: false } } };
export const LegalEnglishMobile: Story = { ...Legal, globals: { locale: 'en', viewport: { value: 'mobile', isRotated: false } } };

export const NotFound: Story = { parameters: { pathname: '/missing-page', ...guest } };
export const NotFoundMobile: Story = { ...NotFound, globals: { viewport: { value: 'mobile', isRotated: false } } };
export const NotFoundEnglishMobile: Story = { ...NotFound, globals: { locale: 'en', viewport: { value: 'mobile', isRotated: false } } };

export const UploadDialog: Story = {
  ...Library,
  parameters: { pathname: '/videos?upload=true' },
  async play(context) {
    await meta.play(context);
    await expect(await within(context.canvasElement.ownerDocument.body).findByRole('dialog')).toBeVisible();
  },
};
export const UploadDialogMobile: Story = { ...UploadDialog, globals: { viewport: { value: 'mobile', isRotated: false } } };
export const UploadDialogEnglishMobile: Story = { ...UploadDialog, globals: { locale: 'en', viewport: { value: 'mobile', isRotated: false } } };
export const CreateCourseDialog: Story = {
  ...Courses,
  async play(context) {
    await meta.play(context);
    const canvas = within(context.canvasElement);
    const button = await canvas.findByRole('button', { name: i18n.t('videos.courses.create') });
    await context.userEvent.click(button);
    const dialog = await within(context.canvasElement.ownerDocument.body).findByRole('dialog');
    await expect(dialog).toBeVisible();
    await expect(within(dialog).getAllByRole('textbox')[0]).toHaveAccessibleDescription();
  },
};
export const CreateCourseDialogMobile: Story = { ...CreateCourseDialog, globals: { viewport: { value: 'mobile', isRotated: false } } };
export const CreateCourseDialogEnglishMobile: Story = { ...CreateCourseDialog, globals: { locale: 'en', viewport: { value: 'mobile', isRotated: false } } };
