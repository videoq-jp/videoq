import { useTranslation } from 'react-i18next';
import {
  Dialog, DialogBody, DialogClose, DialogContent, DialogHeader,
  DialogHeading, DialogScrollArea, useDialog,
} from '@/components/ui/dialog';
import { useChatAnalytics } from '@/hooks/useChatAnalytics';
import { AnalyticsDashboard } from './AnalyticsDashboard';

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
