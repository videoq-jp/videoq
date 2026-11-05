import type { Preview } from '@storybook/react-vite';
import { I18nextProvider } from 'react-i18next';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { mswLoader } from 'msw-storybook-addon/csf3';
import { QueryClientProvider } from '@tanstack/react-query';
import { sb } from 'storybook/test';
import { appQueryClient } from '../src/lib/queryClient';
import { AuthProvider } from '../src/components/auth/AuthProvider';
import { FeedbackProvider } from '../src/components/common/FeedbackProvider';
import { setupMockWorker } from './mocks/network';
import { prepareStoryEnvironment } from './mocks/environment';
import i18n from '../src/i18n/config';
import '../src/index.css';

sb.mock(import('../src/lib/authSession.ts'));
sb.mock(import('../src/lib/moodleConnect.ts'), { spy: true });
sb.mock(import('../src/hooks/useVideoUpload.ts'));

const preview: Preview = {
  tags: ['autodocs'],
  loaders: [mswLoader(setupMockWorker)],
  globalTypes: {
    locale: {
      description: '表示言語 / Language',
      toolbar: {
        icon: 'globe',
        items: [{ value: 'ja', title: '日本語' }, { value: 'en', title: 'English' }],
        dynamicTitle: true,
      },
    },
  },
  initialGlobals: { locale: 'ja' },
  parameters: {
    layout: 'padded',
    viewport: {
      options: {
        mobile: { name: 'Mobile (390px)', styles: { width: '390px', height: '844px' }, type: 'mobile' },
        tablet: { name: 'Tablet (1024px)', styles: { width: '1024px', height: '768px' }, type: 'tablet' },
        desktop: { name: 'Desktop (1280px)', styles: { width: '1280px', height: '900px' }, type: 'desktop' },
      },
    },
    // Report existing accessibility issues while establishing the catalog.
    a11y: { test: 'todo' },
  },
  async beforeEach(context) {
    const { globals } = context;
    const locale = globals.locale === 'en' ? 'en' : 'ja';
    await i18n.changeLanguage(locale);
    document.documentElement.lang = locale;
    return prepareStoryEnvironment(context);
  },
  decorators: [
    (Story, context) => {
      const locale = context.globals.locale === 'en' ? 'en' : 'ja';
      const pathname = context.parameters.pathname ?? '/';
      const entry = locale === 'en' ? `/en${pathname}` : pathname;
      const story = context.parameters.api
        ? <AuthProvider><FeedbackProvider><Story /></FeedbackProvider></AuthProvider>
        : <Story />;
      return (
        <I18nextProvider i18n={i18n}>
          <QueryClientProvider client={appQueryClient}>
            <MemoryRouter key={`${context.id}:${locale}:${pathname}`} initialEntries={[entry]}>
              <Routes>
                <Route path={locale === 'en' ? '/:locale/*' : '/*'} element={story} />
              </Routes>
            </MemoryRouter>
          </QueryClientProvider>
        </I18nextProvider>
      );
    },
  ],
};

export default preview;
