import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { MoreHorizontal } from 'lucide-react';
import { Button } from '@/components/ui/button';

/** A compact disclosure for viewer actions; its items use the shared MenuList. */
export function ViewerActionsMenu({ label, children }: { label: string; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const id = useId();
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);

  const close = (restoreFocus: boolean) => {
    setOpen(false);
    if (restoreFocus) trigger.current?.focus();
  };

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (event.target instanceof Node && !root.current?.contains(event.target)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        setOpen(false);
        trigger.current?.focus();
      }
    };
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  return (
    <div ref={root} className="relative" onBlur={event => {
      if (event.relatedTarget instanceof Node && !event.currentTarget.contains(event.relatedTarget)) close(false);
    }}>
      <Button ref={trigger} type="button" variant="outline" size="sm"
        aria-label={label} aria-expanded={open} aria-controls={id}
        className="min-h-11 min-w-11 px-3"
        onClick={() => setOpen(value => !value)}
        onKeyDown={event => {
          if (event.key === 'ArrowDown') {
            event.preventDefault();
            setOpen(true);
            requestAnimationFrame(() => panel.current?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus());
          }
        }}>
        <MoreHorizontal className="h-5 w-5" aria-hidden="true" />
      </Button>
      <div ref={panel} id={id} hidden={!open}
        className="absolute right-0 top-full z-40 mt-2 w-64 border border-solid-gray-300 bg-white py-1 text-solid-gray-800 shadow-lg"
        onClickCapture={event => {
          // Restore the trigger before opening a dialog, so closing that dialog
          // returns focus to a visible control rather than a hidden menu item.
          if (event.target instanceof Element && event.target.closest('button:not(:disabled)')) close(true);
        }}>
        {children}
      </div>
    </div>
  );
}
