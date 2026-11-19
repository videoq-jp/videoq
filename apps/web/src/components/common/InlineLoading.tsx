import { useTranslation } from 'react-i18next';
import { ProgressIndicator, ProgressIndicatorSpinner } from '@/components/ui/progress-indicator';
import { cn } from '@/lib/digital-agency/cn';

export function InlineLoading({ message, className }: { message?: string; className?: string }) {
  const { t } = useTranslation();
  const label = message ?? t('common.messages.loading');
  return <ProgressIndicator type="inlined" aria-label={label} className={cn('justify-start text-dns-14N-130 font-normal text-solid-gray-700', className)}>
    <ProgressIndicatorSpinner size="sm" className="shrink-0" />
    <span>{label}</span>
  </ProgressIndicator>;
}
