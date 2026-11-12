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
import { APP_HEADER_CONTAINER_CLASS } from '@/components/layout/layoutTokens';
import { cn } from '@/lib/digital-agency/cn';
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

const megaMenuLinkClassName = cn(
  'site-header-dropdown-link text-blue-1000 underline underline-offset-[0.1875rem]',
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
        className="site-header w-full"
      >
        <div
          className={`mx-auto w-full ${APP_HEADER_CONTAINER_CLASS}`}
        >
          <div className="site-header-content">
            <Link
              href="/"
              className="site-header-logo text-std-20B-150"
            >
              <BrandLogo />
            </Link>

            <div className="site-header-nav">
              <nav
                className="site-header-desktop"
                aria-label={t('navigation.menu')}
              >
                <ul className="site-header-menu">
                  {navLinks.map(({ href, label, key }) => {
                    const isCurrent = activePage === key;
                    return (
                      <li key={key} className="shrink-0">
                        <Link
                          href={href}
                          className="site-header-item"
                          aria-current={isCurrent ? 'page' : undefined}
                        >
                          {label}
                        </Link>
                      </li>
                    );
                  })}
                </ul>
              </nav>

              <div ref={langRootRef} className="site-header-desktop relative">
                <LanguageSelector>
                  <LanguageSelectorButton
                    ref={langButtonRef}
                    className="site-header-language"
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
                    <div className="site-header-language-menu absolute top-full z-50">
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
                <div className="site-header-desktop">
                  <Link href="/login" className="site-header-item">
                    {t('auth.login.submit')}
                  </Link>
                </div>
              ) : (
                <div className="site-header-desktop">
                  <button
                    type="button"
                    className="site-header-item"
                    disabled={logoutMutation.isPending}
                    onClick={() => void handleLogout()}
                  >
                    {t('navigation.logout')}
                  </button>
                </div>
              )}

              <HamburgerMenuButton
                ref={menuButtonRef}
                className="site-header-item site-header-toggle"
                aria-expanded={isMenuOpen}
                aria-controls={megaMenuId}
                onClick={() => setIsMenuOpen((open) => !open)}
              >
                {isMenuOpen ? (
                  <>
                    <CloseIcon className="flex-none" />
                    <span>{t('navigation.closeMenu')}</span>
                  </>
                ) : (
                  <>
                    <HamburgerIcon className="flex-none" />
                    <span>{t('navigation.menu')}</span>
                  </>
                )}
              </HamburgerMenuButton>
            </div>
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
            <div className="contents">
              <div
                id={megaMenuId}
                className="site-header-dropdown"
              >
                <nav
                  className="site-header-dropdown-content"
                  aria-label={t('navigation.menu')}
                >
                  <div className="site-header-dropdown-grid">
                    <ul className="site-header-dropdown-list grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3">
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

                    <ul className="site-header-dropdown-list site-header-dropdown-secondary">
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
                      {features.publicSignup && !isAuthenticated && (
                        <li>
                          <Link
                            href="/signup"
                            className={megaMenuLinkClassName}
                            onClick={() => {
                              trackLandingEvent('signup_click', 'header');
                              closeMenu();
                            }}
                          >
                            {t('landing.start')}
                          </Link>
                        </li>
                      )}
                    </ul>
                  </div>
                </nav>
              </div>
            </div>
          </>
        ) : null}
      </header>

    </>
  );
}
