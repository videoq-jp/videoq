import { ProgressIndicator, ProgressIndicatorSpinner } from '@/components/ui/progress-indicator';
import { cn } from '@/lib/digital-agency/cn';

interface InlineSpinnerProps {
  className?: string;
  color?: 'current' | 'blue' | 'red';
}

/** Decorative indicator; the surrounding button or status supplies its label. */
export function InlineSpinner({ className, color = 'current' }: InlineSpinnerProps) {
  return (
    <ProgressIndicator type="inlined" aria-hidden="true" className={cn(
      'inline-flex h-6 w-6 shrink-0',
      color === 'current' ? 'text-inherit' : color === 'red' ? 'text-error-1' : 'text-key-900',
      className,
    )}>
      <ProgressIndicatorSpinner size="sm" inheritColor className="h-full w-full" />
    </ProgressIndicator>
  );
}
