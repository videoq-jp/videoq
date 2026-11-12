import { useCallback, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useLocation } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { X } from 'lucide-react';
import {
  Dialog,
  DialogActions,
  DialogBody,
  DialogContent,
  DialogHeader,
  DialogHeading,
  useDialog,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/digital-agency/cn';
import { FeedbackContext, type ConfirmOptions, type FeedbackContextValue, type ToastOptions } from './feedback';

interface ConfirmRequest {
  options: ConfirmOptions;
  navigationKey: string;
  resolve: (confirmed: boolean) => void;
}

interface ToastItem extends Required<Omit<ToastOptions, 'durationMs'>> {
  id: number;
}

export function FeedbackProvider({ children }: { children: ReactNode }) {
  const { t } = useTranslation();
  const location = useLocation();
  const navigationKey = `${location.pathname}${location.search}${location.hash}`;
  const previousNavigationKey = useRef(navigationKey);
  const activeConfirmRequest = useRef<ConfirmRequest | null>(null);
  const [confirmRequest, setConfirmRequestState] = useState<ConfirmRequest | null>(null);
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const nextToastId = useRef(1);
  const toastTimers = useRef(new Map<number, number>());

  useLayoutEffect(() => {
    const timers = toastTimers.current;
    return () => {
      activeConfirmRequest.current?.resolve(false);
      activeConfirmRequest.current = null;
      for (const timer of timers.values()) window.clearTimeout(timer);
      timers.clear();
    };
  }, []);

  const visibleConfirmRequest =
    confirmRequest && confirmRequest.navigationKey === navigationKey
      ? confirmRequest
      : null;
  const isConfirmOpen = !!visibleConfirmRequest;
  const {
    dialogProps: { ref: confirmDialogRef, 'aria-labelledby': confirmHeadingId },
    headingProps,
  } = useDialog({
    open: isConfirmOpen,
    onOpenChange: (open) => {
      if (!open) resolveConfirm(false);
    },
  });

  const resolveConfirm = useCallback((confirmed: boolean) => {
    const current = activeConfirmRequest.current;
    if (!current) return;

    // Close before unmounting so the native dialog restores the opener's focus.
    confirmDialogRef.current?.close();
    activeConfirmRequest.current = null;
    setConfirmRequestState(null);
    current.resolve(confirmed);
  }, [confirmDialogRef]);

  const requestConfirmation = useCallback((options: ConfirmOptions) => {
    return new Promise<boolean>((resolve) => {
      activeConfirmRequest.current?.resolve(false);

      const nextRequest = {
        options,
        navigationKey,
        resolve,
      };
      activeConfirmRequest.current = nextRequest;
      setConfirmRequestState(nextRequest);
    });
  }, [navigationKey]);

  useLayoutEffect(() => {
    if (previousNavigationKey.current === navigationKey) {
      return;
    }

    previousNavigationKey.current = navigationKey;
    const current = activeConfirmRequest.current;
    if (current && current.navigationKey !== navigationKey) {
      activeConfirmRequest.current = null;
      current.resolve(false);
      window.queueMicrotask(() => {
        setConfirmRequestState((latest) => (latest === current ? null : latest));
      });
    }
  }, [navigationKey]);

  const dismissToast = useCallback((id: number) => {
    window.clearTimeout(toastTimers.current.get(id));
    toastTimers.current.delete(id);
    setToasts((current) => current.filter((toast) => toast.id !== id));
  }, []);

  const toast = useCallback((options: ToastOptions) => {
    const id = nextToastId.current;
    nextToastId.current += 1;
    const item: ToastItem = {
      id,
      message: options.message,
      variant: options.variant ?? 'info',
    };

    setToasts((current) => [...current, item]);

    if (options.durationMs !== 0) {
      toastTimers.current.set(id, window.setTimeout(() => dismissToast(id), options.durationMs ?? 4000));
    }
  }, [dismissToast]);

  const contextValue = useMemo<FeedbackContextValue>(() => ({
    requestConfirmation,
    toast,
  }), [requestConfirmation, toast]);

  return (
    <FeedbackContext.Provider value={contextValue}>
      {children}

      {isConfirmOpen && visibleConfirmRequest && (
        <Dialog ref={confirmDialogRef} aria-labelledby={confirmHeadingId} width="min(28rem, 92vw)">
          <DialogContent>
            <DialogHeader>
              <DialogHeading {...headingProps}>
                {visibleConfirmRequest.options.title}
              </DialogHeading>
            </DialogHeader>
            {visibleConfirmRequest.options.description && (
              <DialogBody>
                <p className="text-std-17N-170 text-solid-gray-700">
                  {visibleConfirmRequest.options.description}
                </p>
              </DialogBody>
            )}
            <DialogActions>
              <div className="flex justify-end gap-3">
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => resolveConfirm(false)}
                >
                  {visibleConfirmRequest.options.cancelLabel ?? t('common.actions.cancel')}
                </Button>
                <Button
                  type="button"
                  variant="solid"
                  className={
                    visibleConfirmRequest.options.variant === 'danger'
                      ? 'bg-error-1 hover:bg-red-1000 active:bg-red-1200'
                      : undefined
                  }
                  onClick={() => resolveConfirm(true)}
                >
                  {visibleConfirmRequest.options.confirmLabel ?? t('common.actions.confirm')}
                </Button>
              </div>
            </DialogActions>
          </DialogContent>
        </Dialog>
      )}

      {toasts.length > 0 && (
        <div className="fixed bottom-[calc(1rem+env(safe-area-inset-bottom))] right-4 z-50 flex w-[min(calc(100%-2rem),24rem)] flex-col gap-2 max-lg:bottom-[calc(5rem+env(safe-area-inset-bottom))]">
          {toasts.map((toastItem) => (
            <div
              key={toastItem.id}
              role={toastItem.variant === 'error' ? 'alert' : 'status'}
              className={cn(
                'flex items-start gap-3 border bg-white px-4 py-3 text-std-17N-170 font-medium',
                toastItem.variant === 'error' && 'border-error-1 text-error-1',
                toastItem.variant === 'success' && 'border-success-2 text-success-2',
                toastItem.variant === 'info' && 'border-solid-gray-420 text-solid-gray-800',
              )}
            >
              <span className="flex-1 leading-5">{toastItem.message}</span>
              <button
                type="button"
                aria-label={t('common.actions.dismissNotification')}
                className="rounded-full p-1 text-current opacity-70 transition-opacity hover:opacity-100"
                onClick={() => dismissToast(toastItem.id)}
              >
                <X className="h-4 w-4" />
              </button>
            </div>
          ))}
        </div>
      )}
    </FeedbackContext.Provider>
  );
}
