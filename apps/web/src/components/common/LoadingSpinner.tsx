import { useTranslation } from 'react-i18next';
import {
  ProgressIndicator,
  ProgressIndicatorSpinner,
} from '@/components/ui/progress-indicator';

interface LoadingSpinnerProps {
  message?: string;
  /** Reserve space within the page content; never covers navigation or other sections. */
  fullScreen?: boolean;
}

export function LoadingSpinner({ message, fullScreen = false }: LoadingSpinnerProps) {
  const { t } = useTranslation();
  const label = message ?? t('common.messages.loading');
  const spinner = (
    <div className={fullScreen
      ? 'flex min-h-[50dvh] items-center justify-center p-6'
      : 'flex items-center justify-center py-8'}>
      <ProgressIndicator type="stacked" aria-label={label}>
        <ProgressIndicatorSpinner />
        <span className="text-center text-std-17N-170 text-solid-gray-600">
          {label}
        </span>
      </ProgressIndicator>
    </div>
  );

  return spinner;
}
