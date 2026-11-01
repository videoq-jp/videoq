import { StrictMode, type ReactNode } from 'react';
import { I18nextProvider } from 'react-i18next';
import i18n from '@/i18n/config';
import App from '@/App';
import { AuthProvider } from '@/components/auth/AuthProvider';
import { FeedbackProvider } from '@/components/common/FeedbackProvider';

/** The tree shared by the browser and the prerenderer. Each supplies its own router. */
export function AppRoot({ router: Router, devtools }: { router: (props: { children: ReactNode }) => ReactNode; devtools?: ReactNode }) {
  return (
    <StrictMode>
      <Router>
        <I18nextProvider i18n={i18n}>
          <AuthProvider>
            <FeedbackProvider>
              <App />
            </FeedbackProvider>
            {devtools}
          </AuthProvider>
        </I18nextProvider>
      </Router>
    </StrictMode>
  );
}
