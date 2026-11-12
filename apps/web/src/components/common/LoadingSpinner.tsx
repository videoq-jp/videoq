import { useTranslation } from 'react-i18next';
import {
  ProgressIndicator,
  ProgressIndicatorSpinner,
} from '@/components/ui/progress-indicator';

interface LoadingSpinnerProps {
  message?: string;
  /** Use only when loading replaces the page content; section loading stays in its own layout. */
  fullScreen?: boolean;
}

export function LoadingSpinner({ message, fullScreen = false }: LoadingSpinnerProps) {
  const { t } = useTranslation();
  const label = message ?? t('common.messages.loading');
  const spinner = (
    <div className={fullScreen
      ? 'pointer-events-none fixed inset-0 z-10 flex items-center justify-center p-6'
      : 'flex items-center justify-center py-8'}>
      <ProgressIndicator type="stacked" aria-label={label}>
        <ProgressIndicatorSpinner />
        <span className="text-center text-std-17N-170 text-solid-gray-600">
          {label}
        </span>
      </ProgressIndicator>
    </div>
  );

  // Keep space in the page so short viewports do not pull the footer under the fixed indicator.
  return fullScreen ? <div className="min-h-[50dvh]">{spinner}</div> : spinner;
}
