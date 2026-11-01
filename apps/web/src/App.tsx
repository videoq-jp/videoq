import { isOnprem } from "@/lib/deployment";
import { lazy, useSyncExternalStore } from 'react';
import { Navigate, Outlet, Route, Routes, useLocation, useParams } from 'react-router-dom';
import { addLocalePrefix, getSavedLocale, useLocaleSync } from '@/lib/i18n';
import { defaultLocale, locales, type Locale } from '@/i18n/config';
import { withQueryAndHash } from '@/lib/seo';
import { AppRouteLayout, AuthRouteLayout, type AppPageRoute } from '@/components/layout/AppRouteLayout';
import { RouteContent } from '@/components/layout/RouteContent';
import HomePage from '@/pages/HomePage';
import NotFoundPage from '@/pages/NotFoundPage';

const LoginPage = lazy(() => import('@/pages/LoginPage'));
const SignupPage = isOnprem ? null : lazy(() => import('@/pages/SignupPage'));
const SignupCheckEmailPage = isOnprem ? null : lazy(() => import('@/pages/SignupCheckEmailPage'));
const SignupCompletePage = isOnprem ? null : lazy(() => import('@/pages/SignupCompletePage'));
const ForgotPasswordPage = isOnprem ? null : lazy(() => import('@/pages/ForgotPasswordPage'));
const ResetPasswordPage = lazy(() => import('@/pages/ResetPasswordPage'));
const VerifyEmailPage = isOnprem ? null : lazy(() => import('@/pages/VerifyEmailPage'));
const EmailChangeConfirmPage = isOnprem ? null : lazy(() => import('@/pages/EmailChangeConfirmPage'));
const ConsentPage = lazy(() => import('@/pages/ConsentPage'));
const VideoLibraryPage = lazy(() => import('@/pages/VideoLibraryPage'));
const VideoDetailPage = lazy(() => import('@/pages/VideoDetailPage'));
const VideoCoursesPage = lazy(() => import('@/pages/VideoCoursesPage'));
const VideoCourseDetailPage = lazy(() => import('@/pages/VideoCourseDetailPage'));
const SharePage = lazy(() => import('@/pages/SharePage'));
const CourseInvitationPage = lazy(() => import('@/pages/CourseInvitationPage'));
const SettingsPage = lazy(() => import('@/pages/SettingsPage'));
const TryPage = isOnprem ? null : lazy(() => import('@/pages/TryPage'));
const PricingPage = isOnprem ? null : lazy(() => import('@/pages/PricingPage'));
const LegalPage = isOnprem ? null : lazy(() => import('@/pages/LegalPage'));
const AdminPage = lazy(() => import('@/pages/AdminPage'));
const GuideIndexPage = isOnprem ? null : lazy(() => import('@/pages/GuideIndexPage'));
const GuidePage = isOnprem ? null : lazy(() => import('@/pages/GuidePage'));

const hydrationSubscription = () => () => undefined;
const clientReady = () => true;
const serverReady = () => false;

function LocaleGate() {
  const params = useParams<{ locale?: string }>();
  const location = useLocation();
  const locale = params.locale;
  // The first browser render must match prerendered HTML before preference redirects.
  const mounted = useSyncExternalStore(hydrationSubscription, clientReady, serverReady);

  // Must be called unconditionally (rules-of-hooks)
  useLocaleSync();

  if (locale && !locales.includes(locale as Locale)) {
    return <NotFoundPage />;
  }

  // Use the router-decoded locale to normalize only the matched prefix:
  // /ja/foo → /foo, /%65n/foo → /en/foo. Preserve the rest of the URL as encoded.
  if (locale) {
    const pathname = locale === defaultLocale
      ? location.pathname.replace(/^\/[^/]+(\/|$)/, '$1') || '/'
      : location.pathname.replace(/^\/[^/]+/, `/${locale}`);
    if (pathname !== location.pathname) {
      return <Navigate to={withQueryAndHash(pathname, location.search, location.hash)} replace />;
    }
  }

  // Returning visitors who explicitly chose English. Never use Accept-Language
  // here — Googlebot would be sent to /en/ and index English as the homepage.
  if (!locale && mounted) {
    const saved = getSavedLocale();
    if (saved && saved !== defaultLocale) {
      const nextPath = withQueryAndHash(
        addLocalePrefix(location.pathname, saved),
        location.search,
        location.hash,
      );
      return <Navigate to={nextPath} replace />;
    }
  }

  return <Outlet />;
}

const appPageRoutes: AppPageRoute[] = [
  { index: true, element: <HomePage />, handle: { activePage: 'home' } },
  { path: 'videos', element: <VideoLibraryPage />, handle: { activePage: 'videoLibrary' } },
  { path: 'videos/:id', element: <VideoDetailPage />, handle: { activePage: 'videoLibrary', variant: 'workspace' } },
  { path: 'videos/courses', element: <VideoCoursesPage />, handle: { activePage: 'courses' } },
  { path: 'videos/courses/:id', element: <VideoCourseDetailPage />, handle: { activePage: 'courses', variant: 'workspace' } },
  { path: 'settings', element: <SettingsPage />, handle: { activePage: 'settings' } },
  ...(!isOnprem && PricingPage && LegalPage && GuideIndexPage && GuidePage ? [
  { path: 'guides', element: <GuideIndexPage />, handle: {} },
  { path: 'guides/:slug', element: <GuidePage />, handle: {} },
  { path: 'pricing', element: <PricingPage />, handle: { activePage: 'pricing' } },
  { path: 'terms', element: <LegalPage page="terms" />, handle: {} },
  { path: 'privacy', element: <LegalPage page="privacy" />, handle: {} },
  { path: 'refund', element: <LegalPage page="refund" />, handle: {} },
  { path: 'legal', element: <LegalPage page="scta" />, handle: {} },
  ] as AppPageRoute[] : []),
  { path: 'admin', element: <AdminPage />, handle: { activePage: 'admin' } },
];

const routeChildren = (
  <>
    <Route element={<AppRouteLayout routes={appPageRoutes} />}>
      {appPageRoutes.map((route) => <Route key={route.path ?? 'home'} {...route} />)}
    </Route>

    <Route element={<AuthRouteLayout />}>
      <Route path="login" element={<LoginPage />} />
      {SignupPage && <Route path="signup" element={<SignupPage />} />}
      {SignupCheckEmailPage && <Route path="signup/check-email" element={<SignupCheckEmailPage />} />}
      {SignupCompletePage && <Route path="signup/complete" element={<SignupCompletePage method="google" />} />}
      {SignupCompletePage && <Route path="signup/verified" element={<SignupCompletePage method="email" />} />}
      {ForgotPasswordPage && <Route path="forgot-password" element={<ForgotPasswordPage />} />}
      <Route path="reset-password" element={<ResetPasswordPage />} />
      {VerifyEmailPage && <Route path="verify-email" element={<VerifyEmailPage />} />}
      {EmailChangeConfirmPage && <Route path="change-email" element={<EmailChangeConfirmPage />} />}
      <Route path="consent" element={<ConsentPage />} />
      <Route path="course-invitations/:token" element={<CourseInvitationPage />} />
    </Route>

    {/* Public shared courses have their own header and full-screen UI. */}
    <Route element={<RouteContent />}>
      <Route path="share/:token" element={<SharePage />} />
      {TryPage && <Route path="try" element={<TryPage />} />}
    </Route>
  </>
);

export default function App() {
  return (
    <Routes>
      {/* Default locale (no prefix) */}
      <Route path="/" element={<LocaleGate />}>
        {routeChildren}
      </Route>

      {/* Localized routes: /:locale/... */}
      <Route path=":locale" element={<LocaleGate />}>
        {routeChildren}
      </Route>
      <Route path="*" element={<NotFoundPage />} />
    </Routes>
  );
}
