import { useId, type MouseEventHandler, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { InlineSpinner } from '@/components/common/InlineSpinner';
import { Button } from '@/components/ui/button';
import { Heading, HeadingTitle } from '@/components/ui/heading';
import { Dialog, DialogActions, DialogBody, DialogContent, DialogHeader, DialogHeading, useDialog } from '@/components/ui/dialog';

interface ConnectedAppCardProps {
  name: string;
  subtitle?: string;
  headingLevel?: 'h2' | 'h3' | 'h4';
  disabled: boolean;
  disconnecting: boolean;
  onDisconnect: MouseEventHandler<HTMLButtonElement>;
  children: ReactNode;
}

export function ConnectedAppCard({ name, subtitle, headingLevel = 'h3', disabled, disconnecting, onDisconnect, children }: ConnectedAppCardProps) {
  const { t } = useTranslation();
  const headingId = useId();
  return (
    <article aria-labelledby={headingId} className="rounded-8 border border-solid-gray-200 p-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0 flex-1">
          <Heading size="16"><HeadingTitle id={headingId} level={headingLevel} className="break-words [overflow-wrap:anywhere]">{name}</HeadingTitle></Heading>
          {subtitle && <p className="mt-1 break-words text-dns-14N-130 text-solid-gray-600 [overflow-wrap:anywhere]">{subtitle}</p>}
        </div>
        <Button
          type="button"
          variant="text"
          size="sm"
          disabled={disabled}
          aria-busy={disconnecting}
          aria-label={`${t('settings.connectedApps.revoke')}: ${name}${subtitle ? ` — ${subtitle}` : ''}`}
          className="shrink-0 self-start text-error-1 hover:bg-red-50"
          onClick={onDisconnect}
        >
          {disconnecting && <InlineSpinner className="mr-1 h-4 w-4" />}
          {t(disconnecting ? 'settings.connectedApps.revoking' : 'settings.connectedApps.revoke')}
        </Button>
      </div>
      <details className="mt-3 text-solid-gray-600">
        <summary className="w-fit cursor-pointer rounded-4 text-std-16N-170 underline underline-offset-4 focus-visible:outline focus-visible:outline-4 focus-visible:outline-offset-2 focus-visible:outline-black">
          {t('settings.connectedApps.details')}
        </summary>
        <div className="mt-3 rounded-8 bg-solid-gray-50 p-4 text-dns-14N-130">{children}</div>
      </details>
    </article>
  );
}

interface DisconnectAppDialogProps {
  open: boolean;
  name: string;
  subtitle?: string;
  description: string;
  pending: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: () => void;
}

export function DisconnectAppDialog({ open, name, subtitle, description, pending, onOpenChange, onConfirm }: DisconnectAppDialogProps) {
  const { t } = useTranslation();
  const descriptionId = useId();
  const confirmation = useDialog({
    open,
    onOpenChange,
    onRequestClose: (event) => { if (pending) event.preventDefault(); },
  });
  if (!open) return null;
  return (
    <Dialog {...confirmation.dialogProps} width="min(32rem, 92vw)" aria-describedby={descriptionId}>
      <DialogContent>
        <DialogHeader>
          <DialogHeading {...confirmation.headingProps}>{t('settings.connectedApps.confirmTitle')}</DialogHeading>
        </DialogHeader>
        <DialogBody>
          <p className="break-words text-std-16B-170 [overflow-wrap:anywhere]">{name}</p>
          {subtitle && <p className="mt-1 break-words text-dns-14N-130 text-solid-gray-600 [overflow-wrap:anywhere]">{subtitle}</p>}
          <p id={descriptionId} className="mt-3 text-std-16N-170 text-solid-gray-700">{description}</p>
        </DialogBody>
        <DialogActions>
          <div className="flex flex-wrap justify-end gap-3">
            <Button variant="outline" disabled={pending} onClick={() => onOpenChange(false)}>{t('settings.cancel')}</Button>
            <Button className="bg-error-1 hover:bg-red-1000 active:bg-red-1200" disabled={pending} onClick={onConfirm}>
              {pending && <InlineSpinner className="mr-1 h-4 w-4" />}
              {t(pending ? 'settings.connectedApps.revoking' : 'settings.connectedApps.revoke')}
            </Button>
          </div>
        </DialogActions>
      </DialogContent>
    </Dialog>
  );
}
