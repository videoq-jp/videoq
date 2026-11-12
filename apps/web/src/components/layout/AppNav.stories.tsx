import type { ComponentProps } from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, fn, waitFor, within } from 'storybook/test';
import { useLocation } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { http, HttpResponse } from 'msw';
import { removeLocalePrefix } from '@/lib/i18n';
import { authFixtures } from '../../../.storybook/fixtures/auth';
import { pending, restPost } from '../../../.storybook/mocks/network';
import { AppNav } from './AppNav';

const logout = fn();
const menuName = /すべてのメニュー|All menus/;
const closeMenuName = /メニューを閉じる|Close menu/;
const logoutName = /ログアウト|Log out/;
const api = {
  auth: authFixtures.user,
  rest: [http.post('/api/auth/sign-out', () => { logout(); return HttpResponse.json({ success: true }); })],
};

function NavigationExample(args: ComponentProps<typeof AppNav>) {
  const location = useLocation();
  const { i18n } = useTranslation();
  const en = i18n.language === 'en';
  const isLogin = removeLocalePrefix(location.pathname) === '/login';
  return (
    <>
      {!isLogin && <AppNav {...args} />}
      <main className="min-h-[640px] bg-solid-gray-50 p-6 lg:p-8">
        <h1 className="mb-4 text-std-28B-150">{isLogin ? (en ? 'Sign in' : 'ログイン') : (en ? 'Learning workspace' : '学習ワークスペース')}</h1>
        <output aria-label="Current route" className="break-all text-solid-gray-600">{location.pathname}{location.search}{location.hash}</output>
      </main>
    </>
  );
}

function menuPanel(canvasElement: HTMLElement, trigger: HTMLElement) {
  const panel = canvasElement.ownerDocument.getElementById(trigger.getAttribute('aria-controls')!);
  if (!panel) throw new Error('Navigation panel did not open');
  return panel;
}

const meta = {
  title: 'Layout/AppNav',
  component: AppNav,
  render: NavigationExample,
  args: { activePage: 'videoLibrary' },
  globals: { viewport: { value: 'desktop', isRotated: false } },
  parameters: { layout: 'fullscreen', pathname: '/videos', api, docs: { story: { inline: false, height: '720px' } } },
  beforeEach() {
    logout.mockClear();
    const saved = localStorage.getItem('videoq.locale');
    return () => {
      if (saved === null) localStorage.removeItem('videoq.locale');
      else localStorage.setItem('videoq.locale', saved);
    };
  },
  async play({ canvasElement }) {
    await expect(within(canvasElement).getByRole('link', { name: 'VideoQ' })).toBeVisible();
  },
} satisfies Meta<typeof AppNav>;
export default meta;
type Story = StoryObj<typeof meta>;

export const LoggedOut: Story = {
  args: { activePage: 'home' },
  parameters: { api: { ...api, auth: authFixtures.loggedOut }, pathname: '/' },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole('link', { name: /ログイン|Log in|Sign in/ })).toBeVisible();
    await expect(canvas.queryByRole('link', { name: /ライブラリ|Library/ })).not.toBeInTheDocument();
    await expect(canvas.getByRole('link', { name: /ホーム|Home/ })).toHaveAttribute('aria-current', 'page');
  },
};
export const Member: Story = {
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole('link', { name: /ライブラリ|Library/ })).toHaveAttribute('aria-current', 'page');
    await expect(canvas.queryByRole('link', { name: /^(管理|Admin)$/ })).not.toBeInTheDocument();
  },
};
export const Administrator: Story = {
  args: { activePage: 'admin' },
  parameters: { api: { ...api, auth: authFixtures.admin }, pathname: '/admin' },
  async play({ canvasElement }) {
    await expect(await within(canvasElement).findByRole('link', { name: /^(管理|Admin)$/ })).toHaveAttribute('aria-current', 'page');
  },
};
export const ActiveCourses: Story = { args: { activePage: 'courses' }, parameters: { pathname: '/videos/courses' } };
export const ActiveSettings: Story = { args: { activePage: 'settings' }, parameters: { pathname: '/settings' } };
export const ActivePricing: Story = { args: { activePage: 'pricing' }, parameters: { pathname: '/pricing' } };
export const DesktopMenu: Story = {
  async play({ canvasElement, userEvent }) {
    const canvas = within(canvasElement);
    const trigger = canvas.getByRole('button', { name: menuName });
    await userEvent.click(trigger);
    await expect(trigger).toHaveAttribute('aria-expanded', 'true');
    await expect(within(menuPanel(canvasElement, trigger)).getByRole('link', { name: /ライブラリ|Library/ })).toHaveAttribute('aria-current', 'page');
  },
};
export const MobileMenu: Story = { ...DesktopMenu, globals: { viewport: { value: 'mobile', isRotated: false } } };
export const LoggedOutMobile: Story = {
  ...MobileMenu,
  parameters: { api: { ...api, auth: authFixtures.loggedOut }, pathname: '/' },
  async play({ canvasElement, userEvent }) {
    const canvas = within(canvasElement);
    const trigger = canvas.getByRole('button', { name: menuName });
    await userEvent.click(trigger);
    const panel = within(menuPanel(canvasElement, trigger));
    await expect(panel.getByRole('link', { name: /ログイン|Log in|Sign in/ })).toBeVisible();
    await expect(panel.queryByRole('link', { name: /ライブラリ|Library/ })).not.toBeInTheDocument();
  },
};
export const EnglishMobile: Story = { ...MobileMenu, globals: { locale: 'en', viewport: { value: 'mobile', isRotated: false } } };
export const EnglishAdministrator: Story = { ...Administrator, globals: { locale: 'en', viewport: { value: 'desktop', isRotated: false } } };
export const EnglishAdministratorTablet: Story = {
  ...Administrator,
  globals: { locale: 'en', viewport: { value: 'tablet', isRotated: false } },
  async play({ canvasElement, userEvent }) {
    const canvas = within(canvasElement);
    const trigger = canvas.getByRole('button', { name: menuName });
    const viewportWidth = canvasElement.ownerDocument.documentElement.getBoundingClientRect().width;
    // At 1024px the real site shows desktop navigation; it must still fit.
    await expect(trigger.getBoundingClientRect().right).toBeLessThanOrEqual(viewportWidth);
    await expect(canvas.getByRole('button', { name: logoutName })).toBeVisible();
    const brand = canvasElement.querySelector('.site-header-logo')!;
    const nav = canvasElement.querySelector('.site-header-nav')!;
    await expect(nav.getBoundingClientRect().left).toBeGreaterThanOrEqual(brand.getBoundingClientRect().right);
    await userEvent.click(trigger);
    const panel = within(menuPanel(canvasElement, trigger));
    await expect(await panel.findByRole('link', { name: 'Admin' })).toHaveAttribute('aria-current', 'page');
    await expect(panel.getByRole('button', { name: logoutName })).toBeVisible();
  },
};
export const LanguageMenu: Story = {
  async play({ canvasElement, userEvent }) {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole('button', { name: 'Language' }));
    await expect(canvas.getByRole('link', { name: '日本語' })).toBeVisible();
    await expect(canvas.getByRole('link', { name: 'English' })).toBeVisible();
  },
};
export const KeyboardMenuEscape: Story = {
  globals: { viewport: { value: 'mobile', isRotated: false } },
  async play({ canvasElement, userEvent }) {
    const canvas = within(canvasElement);
    const trigger = canvas.getByRole('button', { name: menuName });
    trigger.focus();
    await userEvent.keyboard('{Enter}');
    const firstLink = within(menuPanel(canvasElement, trigger)).getByRole('link', { name: /ホーム|Home/ });
    await userEvent.tab();
    await expect(firstLink).toHaveFocus();
    await userEvent.keyboard('{Escape}');
    await expect(trigger).toHaveAttribute('aria-expanded', 'false');
    await expect(trigger).toHaveFocus();
  },
};
export const KeyboardLanguageEscape: Story = {
  async play({ canvasElement, userEvent }) {
    const canvas = within(canvasElement);
    const trigger = canvas.getByRole('button', { name: 'Language' });
    trigger.focus();
    await userEvent.keyboard('{Enter}');
    await userEvent.tab();
    await expect(menuPanel(canvasElement, trigger)).toContainElement(canvasElement.ownerDocument.activeElement as HTMLElement);
    await userEvent.keyboard('{Escape}');
    await expect(trigger).toHaveAttribute('aria-expanded', 'false');
    await expect(trigger).toHaveFocus();
  },
};
export const SwitchLanguage: Story = {
  async play({ canvasElement, userEvent, globals }) {
    const canvas = within(canvasElement);
    const next = globals.locale === 'en' ? '日本語' : 'English';
    await userEvent.click(canvas.getByRole('button', { name: 'Language' }));
    await userEvent.click(canvas.getByRole('link', { name: next }));
    await expect(canvas.getByLabelText('Current route')).toHaveTextContent(globals.locale === 'en' ? '/videos' : '/en/videos');
    await expect(canvas.getByRole('button', { name: 'Language' })).toHaveFocus();
  },
};
export const MenuNavigation: Story = {
  ...MobileMenu,
  async play({ canvasElement, userEvent, globals }) {
    const canvas = within(canvasElement);
    const trigger = canvas.getByRole('button', { name: menuName });
    await userEvent.click(trigger);
    await userEvent.click(within(menuPanel(canvasElement, trigger)).getByRole('link', { name: /講座|Courses/ }));
    await expect(canvas.getByLabelText('Current route')).toHaveTextContent(globals.locale === 'en' ? '/en/videos/courses' : '/videos/courses');
    await expect(canvas.queryByRole('button', { name: closeMenuName })).not.toBeInTheDocument();
  },
};
export const Logout: Story = {
  async play({ canvasElement, userEvent, globals }) {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole('button', { name: logoutName }));
    await waitFor(() => expect(canvas.getByLabelText('Current route')).toHaveTextContent(globals.locale === 'en' ? '/en/login' : '/login'));
    await expect(logout).toHaveBeenCalledTimes(1);
  },
};
export const LogoutPending: Story = {
  parameters: { api: { ...api, rest: [restPost('/api/auth/sign-out', pending())] } },
  async play({ canvasElement, userEvent }) {
    const button = within(canvasElement).getByRole('button', { name: logoutName });
    await userEvent.click(button);
    await waitFor(() => expect(button).toBeDisabled());
  },
};

export const LogoutFailure: Story = {
  parameters: {
    api: {
      ...api,
      rest: [http.post('/api/auth/sign-out', () => {
        logout();
        return logout.mock.calls.length === 1
          ? HttpResponse.json({ message: 'Service unavailable', code: 'SERVICE_UNAVAILABLE' }, { status: 503 })
          : HttpResponse.json({ success: true });
      })],
    },
  },
  async play({ canvasElement, userEvent, globals }) {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole('button', { name: logoutName }));
    await expect(await canvas.findByRole('alert')).toHaveTextContent(/ログアウトできませんでした|Could not log out/);
    await expect(canvas.getByLabelText('Current route')).toHaveTextContent(globals.locale === 'en' ? '/en/videos' : '/videos');
    await expect(canvas.getByRole('button', { name: logoutName })).toBeEnabled();
    await userEvent.click(canvas.getByRole('button', { name: logoutName }));
    await waitFor(() => expect(canvas.getByLabelText('Current route')).toHaveTextContent(globals.locale === 'en' ? '/en/login' : '/login'));
    await expect(logout).toHaveBeenCalledTimes(2);
  },
};
