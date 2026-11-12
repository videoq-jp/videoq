import { BrandLogo } from '@/components/layout/BrandLogo';
import { features } from "@/lib/deployment";
import { useEffect, useId, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useMutation, useQueryClient, useQuery } from '@tanstack/react-query';
import {
  Link,
  addLocalePrefix,
  removeLocalePrefix,
  setPreferredLocale,
  useI18nNavigate,
  useLocale,
} from '@/lib/i18n';
import { type Locale, locales } from '@/i18n/config';
import { apiClient } from '@/lib/api';
import { trackLandingEvent } from '@/lib/landingAnalytics';
import { useAuthSession } from '@/lib/authSession';
import { trpc } from '@/lib/trpc';
import { useToast } from '@/components/common/feedback';
import { APP_CONTAINER_CLASS, APP_HEADER_CONTAINER_CLASS } from '@/components/layout/layoutTokens';
import { cn } from '@/lib/digital-agency/cn';
import { Button } from '@/components/ui/button';
import {
  CloseIcon,
  HamburgerIcon,
  HamburgerMenuButton,
} from '@/components/ui/hamburger-menu-button';
import {
  LanguageSelector,
  LanguageSelectorArrowIcon,
  LanguageSelectorButton,
  LanguageSelectorGlobeIcon,
  LanguageSelectorMenu,
  LanguageSelectorMenuItem,
} from '@/components/ui/language-selector';

export type ActivePage = 'home' | 'videoLibrary' | 'courses' | 'pricing' | 'settings' | 'admin';

interface AppNavProps {
  activePage?: ActivePage;
}

const LOCALE_LABELS: Record<Locale, string> = {
  en: 'English',
  ja: '日本語',
};

const HEADER_OFFSET_VAR = '--app-header-offset';
const HEADER_OFFSET_FALLBACK = '5rem';

const navLinkClassName = (isCurrent: boolean) =>
  cn(
    'inline-flex shrink-0 items-center whitespace-nowrap px-4 py-2 text-oln-14N-100 text-solid-gray-800 no-underline',
    'hover:underline hover:underline-offset-[calc(3/16*1rem)]',
    'focus-visible:outline focus-visible:outline-4 focus-visible:outline-offset-2 focus-visible:outline-black focus-visible:bg-yellow-300',
    isCurrent && 'rounded-full border border-solid-gray-800 font-bold',
  );

const megaMenuLinkClassName = cn(
  'text-blue-1000 text-[1.0625rem] leading-7 tracking-[0.04em] underline underline-offset-[0.1875rem]',
  'hover:text-blue-900 hover:decoration-[0.1875rem]',
  'focus-visible:rounded-4 focus-visible:bg-yellow-300 focus-visible:outline focus-visible:outline-4 focus-visible:outline-offset-2 focus-visible:outline-black',
  'active:text-orange-700',
);

export function AppNav({ activePage }: AppNavProps) {
  const { t } = useTranslation();
  const navigate = useI18nNavigate();
  const routerNavigate = useNavigate();
  const location = useLocation();
  const locale = useLocale();
  const queryClient = useQueryClient();
  const toast = useToast();
  const [isLangOpen, setIsLangOpen] = useState(false);
  const [isMenuOpen, setIsMenuOpen] = useState(false);
  const [menuPathname, setMenuPathname] = useState(location.pathname);
  if (menuPathname !== location.pathname) {
    setMenuPathname(location.pathname);
    setIsMenuOpen(false);
  }
  const langMenuId = useId();
  const megaMenuId = useId();
  const langRootRef = useRef<HTMLDivElement>(null);
  const langButtonRef = useRef<HTMLButtonElement>(null);
  const menuButtonRef = useRef<HTMLButtonElement>(null);
  const headerRef = useRef<HTMLElement>(null);

  const session = useAuthSession();
  const isAuthenticated = Boolean(session.data?.user);
  const authQuery = useQuery(trpc.account.me.queryOptions(undefined, {
    enabled: isAuthenticated && !session.isPending,
    retry: false,
    staleTime: 60_000,
  }));

  const logoutMutation = useMutation({
    mutationFn: async () => await apiClient.logout(),
    onSuccess: () => {
      queryClient.clear();
    },
  });

  const closeMenu = () => setIsMenuOpen(false);

  const handleLogout = async () => {
    try {
      await logoutMutation.mutateAsync();
      closeMenu();
      navigate('/login');
    } catch {
      toast({ message: t('navigation.logoutFailed'), variant: 'error', durationMs: 0 });
    }
  };

  const switchLocale = (next: Locale) => {
    setPreferredLocale(next);
    const pathWithoutLocale = removeLocalePrefix(location.pathname);
    routerNavigate(`${addLocalePrefix(pathWithoutLocale, next)}${location.search}${location.hash}`);
    setIsLangOpen(false);
  };

  useEffect(() => {
    if (!isLangOpen) return;
    const onPointerDown = (event: MouseEvent) => {
      if (!langRootRef.current?.contains(event.target as Node)) {
        setIsLangOpen(false);
      }
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setIsLangOpen(false);
        langButtonRef.current?.focus();
      }
    };
    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [isLangOpen]);

  useEffect(() => {
    if (!isMenuOpen) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setIsMenuOpen(false);
        menuButtonRef.current?.focus();
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [isMenuOpen]);

  useEffect(() => {
    const header = headerRef.current;
    if (!header) return;

    const updateHeaderOffset = () => {
      document.documentElement.style.setProperty(
        HEADER_OFFSET_VAR,
        `${Math.ceil(header.getBoundingClientRect().height)}px`,
      );
    };

    updateHeaderOffset();
    window.addEventListener('resize', updateHeaderOffset);

    const observer =
      typeof ResizeObserver !== 'undefined'
        ? new ResizeObserver(updateHeaderOffset)
        : null;
    observer?.observe(header);

    return () => {
      observer?.disconnect();
      window.removeEventListener('resize', updateHeaderOffset);
      document.documentElement.style.removeProperty(HEADER_OFFSET_VAR);
    };
  }, []);

  const allNavLinks: {
    href: string;
    label: string;
    key: ActivePage;
    authRequired?: boolean;
    adminRequired?: boolean;
  }[] = [
    { href: '/', label: t('navigation.home'), key: 'home' },
    { href: '/videos', label: t('navigation.videoLibrary'), key: 'videoLibrary', authRequired: true },
    { href: '/videos/courses', label: t('navigation.coursesNav'), key: 'courses', authRequired: true },
    { href: '/pricing', label: t('navigation.pricing'), key: 'pricing' },
    { href: '/settings', label: t('navigation.settings'), key: 'settings', authRequired: true },
    {
      href: '/admin',
      label: t('navigation.admin'),
      key: 'admin',
      authRequired: true,
      adminRequired: true,
    },
  ];

  const isAdmin = !!authQuery.data?.is_admin;
  const navLinks = allNavLinks.filter((link) => {
    if (link.key === 'pricing' && !features.billing) return false;
    if (link.authRequired && !isAuthenticated) return false;
    if (link.adminRequired && !isAdmin) return false;
    return true;
  });

  return (
    <>
      <header
        ref={headerRef}
        className="fixed top-0 z-50 w-full bg-white"
      >
        <div
          className={`mx-auto flex w-full items-center justify-between min-h-[4.5rem] gap-6 py-3 md:min-h-20 ${APP_HEADER_CONTAINER_CLASS}`}
        >
          <Link
            href="/"
            className="shrink-0 text-std-20B-150 text-solid-gray-800 no-underline"
          >
            <BrandLogo />
          </Link>

          <div className="flex shrink-0 items-center justify-end gap-4">
            <nav
              className="hidden items-center xl:flex"
              aria-label={t('navigation.menu')}
            >
              <ul className="flex items-center gap-3.5">
                {navLinks.map(({ href, label, key }) => {
                  const isCurrent = activePage === key;
                  return (
                    <li key={key} className="shrink-0">
                      <Link
                        href={href}
                        className={navLinkClassName(isCurrent)}
                        aria-current={isCurrent ? 'page' : undefined}
                      >
                        {label}
                      </Link>
                    </li>
                  );
                })}
              </ul>
            </nav>

            <div
              className="mx-2 hidden h-4 w-px shrink-0 bg-solid-gray-420 xl:block"
              aria-hidden="true"
            />

            <div ref={langRootRef} className="relative hidden xl:block">
              <LanguageSelector>
                <LanguageSelectorButton
                  ref={langButtonRef}
                  className="px-3 text-oln-14N-100"
                  aria-expanded={isLangOpen}
                  aria-controls={langMenuId}
                  onClick={() => setIsLangOpen((open) => !open)}
                >
                  <LanguageSelectorGlobeIcon />
                  <span>Language</span>
                  <LanguageSelectorArrowIcon
                    className={cn('transition-transform', isLangOpen && 'rotate-180')}
                  />
                </LanguageSelectorButton>
                {isLangOpen && (
                  <div className="absolute right-0 top-full z-50 mt-1">
                    <LanguageSelectorMenu id={langMenuId}>
                      {locales.map((code) => (
                        <LanguageSelectorMenuItem
                          key={code}
                          href={addLocalePrefix(removeLocalePrefix(location.pathname), code)}
                          isCurrent={locale === code}
                          onClick={(event) => {
                            event.preventDefault();
                            switchLocale(code);
                            langButtonRef.current?.focus();
                          }}
                        >
                          {LOCALE_LABELS[code]}
                        </LanguageSelectorMenuItem>
                      ))}
                    </LanguageSelectorMenu>
                  </div>
                )}
              </LanguageSelector>
            </div>

            {!isAuthenticated ? (
              <Button variant="text" size="sm" className="hidden px-3 xl:inline-flex" asChild>
                <Link href="/login" className="no-underline">
                  {t('auth.login.submit')}
                </Link>
              </Button>
            ) : (
              <Button
                type="button"
                variant="text"
                size="sm"
                className="hidden px-3 xl:inline-flex"
                disabled={logoutMutation.isPending}
                onClick={() => void handleLogout()}
              >
                {t('navigation.logout')}
              </Button>
            )}

            {features.publicSignup && !isAuthenticated && activePage === 'home' && (
              <Button variant="solid" size="sm" className="hidden sm:inline-flex" asChild>
                <Link href="/signup" onClick={() => trackLandingEvent('signup_click', 'header')}>{t('landing.start')}</Link>
              </Button>
            )}

            <HamburgerMenuButton
              ref={menuButtonRef}
              className="px-3 py-1.5 text-oln-14N-100"
              aria-expanded={isMenuOpen}
              aria-controls={megaMenuId}
              onClick={() => setIsMenuOpen((open) => !open)}
            >
              {isMenuOpen ? (
                <>
                  <CloseIcon className="flex-none" />
                  {t('navigation.closeMenu')}
                </>
              ) : (
                <>
                  <HamburgerIcon className="flex-none" />
                  {t('navigation.menu')}
                </>
              )}
            </HamburgerMenuButton>
          </div>
        </div>

        {isMenuOpen ? (
          <>
            <button
              type="button"
              tabIndex={-1}
              className="fixed top-[var(--app-header-offset,5rem)] inset-x-0 bottom-0 z-40 cursor-default bg-black/20"
              aria-label={t('navigation.closeMenu')}
              onClick={() => { closeMenu(); menuButtonRef.current?.focus(); }}
            />
            <div className="absolute inset-x-0 top-full z-50">
              <div
                id={megaMenuId}
                className="max-h-[calc(100dvh-var(--app-header-offset,5rem))] overflow-y-auto border-t border-solid-gray-300 bg-white/90 shadow-[0_0.25rem_0.25rem_0_#00000029] backdrop-blur-[0.5rem] [scrollbar-gutter:stable]"
              >
                <nav
                  className={`mx-auto w-full py-10 md:py-12 ${APP_CONTAINER_CLASS}`}
                  aria-label={t('navigation.menu')}
                >
                  <ul className="grid grid-cols-1 gap-x-10 gap-y-2 sm:grid-cols-2 lg:grid-cols-3">
                    {navLinks.map(({ href, label, key }) => (
                      <li
                        key={key}
                        className="flex min-h-12 items-center pl-5"
                      >
                        <Link
                          href={href}
                          className={megaMenuLinkClassName}
                          aria-current={activePage === key ? 'page' : undefined}
                          onClick={closeMenu}
                        >
                          {label}
                        </Link>
                      </li>
                    ))}
                  </ul>

                  <div className="my-8 h-px bg-solid-gray-300" aria-hidden="true" />

                  <ul className="grid grid-cols-1 gap-x-10 gap-y-2 sm:grid-cols-2 lg:grid-cols-3">
                    {locales.map((code) => (
                      <li key={code} className="flex min-h-12 items-center pl-5">
                        <button
                          type="button"
                          lang={code}
                          className={cn(megaMenuLinkClassName, 'bg-transparent text-left')}
                          aria-current={locale === code ? 'true' : undefined}
                          onClick={() => {
                            switchLocale(code);
                            closeMenu();
                          }}
                        >
                          {LOCALE_LABELS[code]}
                        </button>
                      </li>
                    ))}
                    <li className="flex min-h-12 items-center pl-5">
                      {!isAuthenticated ? (
                        <Link
                          href="/login"
                          className={megaMenuLinkClassName}
                          onClick={closeMenu}
                        >
                          {t('auth.login.submit')}
                        </Link>
                      ) : (
                        <button
                          type="button"
                          className={cn(megaMenuLinkClassName, 'bg-transparent text-left')}
                          onClick={() => void handleLogout()}
                          disabled={logoutMutation.isPending}
                        >
                          {t('navigation.logout')}
                        </button>
                      )}
                    </li>
                  </ul>
                </nav>
              </div>
            </div>
          </>
        ) : null}
      </header>

      <div
        aria-hidden="true"
        className="w-full shrink-0"
        style={{ height: `var(${HEADER_OFFSET_VAR}, ${HEADER_OFFSET_FALLBACK})` }}
      />
    </>
  );
}
