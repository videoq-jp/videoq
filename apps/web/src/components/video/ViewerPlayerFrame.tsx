import { useId, type ReactNode } from 'react';
import { ChevronDown, ChevronUp } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';

/** Keep playback mounted when making more room for a question on small screens. */
export function ViewerPlayerFrame({ title, expanded, onExpandedChange, children }: {
  title: string; expanded: boolean; onExpandedChange: (expanded: boolean) => void; children: ReactNode;
}) {
  const { t } = useTranslation();
  const id = useId();
  return <div className="min-w-0">
    <div id={id} className={expanded ? '' : 'hidden lg:block'}>{children}</div>
    <div className="flex min-w-0 items-center gap-2 px-4 py-1 lg:px-8 lg:py-4">
      <h2 className="min-w-0 flex-1 truncate text-std-17B-170 lg:whitespace-normal lg:text-std-20B-150" title={title}>{title}</h2>
      <Button type="button" variant="text" size="xs" className="min-h-11 shrink-0 px-2 lg:hidden"
        aria-expanded={expanded} aria-controls={id} onClick={() => onExpandedChange(!expanded)}>
        {expanded ? <ChevronUp className="h-4 w-4" aria-hidden="true" /> : <ChevronDown className="h-4 w-4" aria-hidden="true" />}
        {t(expanded ? 'videos.shared.hidePlayer' : 'videos.shared.showPlayer')}
      </Button>
    </div>
  </div>;
}
