import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { BarChart3 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogBody,
  DialogClose,
  DialogContent,
  DialogHeader,
  DialogHeading,
  DialogScrollArea,
  useDialog,
} from '@/components/ui/dialog';
import { useChatAnalytics } from '@/hooks/useChatAnalytics';
import { AnalyticsDashboard } from './AnalyticsDashboard';

interface DashboardButtonProps {
  courseId: number;
  size?: 'sm' | 'md';
  className?: string;
}

export function DashboardButton({ courseId, size = 'md', className }: DashboardButtonProps) {
  const { t } = useTranslation();
  const [isOpen, setIsOpen] = useState(false);
  return (
    <>
      <Button variant="outline" size={size} onClick={() => setIsOpen(true)}
        aria-label={t('dashboard.button')}
        className={`min-w-9 gap-2 px-2.5 sm:min-w-20 sm:px-3 ${className ?? ''}`}>
        <BarChart3 className="h-4 w-4" />
        <span className="hidden sm:inline">{t('dashboard.button')}</span>
      </Button>

      <DashboardDialog courseId={courseId} open={isOpen} onOpenChange={setIsOpen} />
    </>
  );
}

/** Kept outside collapsed menus so the dialog and its focus target stay visible. */
export function DashboardDialog({ courseId, open, onOpenChange }: {
  courseId: number; open: boolean; onOpenChange: (open: boolean) => void;
}) {
  const { t } = useTranslation();
  const { data, isLoading } = useChatAnalytics(courseId, open);
  const dialog = useDialog({ open, onOpenChange });
  return (
    <Dialog {...dialog.dialogProps} scroll="inner" width="min(64rem, 95vw)">
      {open && <DialogContent>
        <DialogHeader>
          <DialogHeading {...dialog.headingProps}>{t('dashboard.title')}</DialogHeading>
          <DialogClose {...dialog.closeButtonProps}>{t('common.actions.close')}</DialogClose>
        </DialogHeader>
        <DialogScrollArea>
          <DialogBody><AnalyticsDashboard data={data} isLoading={isLoading} /></DialogBody>
        </DialogScrollArea>
      </DialogContent>}
    </Dialog>
  );
}
