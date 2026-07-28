import * as React from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { X } from 'lucide-react';
import { cn } from '~/lib/utils';

/* Ported from the CD Fencing Design System (components/feedback/Modal),
   translated to Tailwind over Radix Dialog (focus trap, scroll lock and Escape
   handling come from Radix). Header (title + close), a scrollable body and an
   optional footer action bar — pass real <Button>s in `footer`. */

const SIZES = { sm: 'max-w-md', md: 'max-w-lg', lg: 'max-w-2xl' };

export interface ModalProps {
  open: boolean;
  onClose: () => void;
  title: React.ReactNode;
  description?: React.ReactNode;
  size?: keyof typeof SIZES;
  footer?: React.ReactNode;
  closeOnOverlay?: boolean;
  children: React.ReactNode;
}

export function Modal({
  open,
  onClose,
  title,
  description,
  size = 'md',
  footer,
  closeOnOverlay = true,
  children,
}: ModalProps) {
  return (
    <Dialog.Root open={open} onOpenChange={(o) => !o && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-[rgba(19,26,33,0.5)] backdrop-blur-[1px]" />
        <Dialog.Content
          onInteractOutside={(e) => {
            if (!closeOnOverlay) e.preventDefault();
          }}
          className={cn(
            'fixed left-1/2 top-1/2 z-50 flex max-h-[calc(100vh-48px)] w-[calc(100vw-32px)] -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-xl border border-border-subtle bg-surface-card shadow-xl',
            SIZES[size],
          )}
        >
          <div className="flex items-start justify-between gap-4 border-b border-border-subtle px-5 py-4">
            <div className="min-w-0">
              <Dialog.Title className="font-sans text-md font-bold leading-snug tracking-tight text-strong">
                {title}
              </Dialog.Title>
              {description && (
                <Dialog.Description className="mt-1 font-sans text-sm leading-normal text-muted">
                  {description}
                </Dialog.Description>
              )}
            </div>
            <Dialog.Close
              aria-label="Close"
              className="-mr-1 inline-flex size-8 shrink-0 items-center justify-center rounded-full text-muted transition-colors hover:bg-gray-100 hover:text-body"
            >
              <X size={18} />
            </Dialog.Close>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">{children}</div>
          {footer && (
            <div className="flex items-center justify-end gap-2.5 border-t border-border-subtle bg-gray-50 px-5 py-3.5">
              {footer}
            </div>
          )}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
