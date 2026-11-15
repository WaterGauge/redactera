import React, { useEffect, useRef } from 'react';

// The native modal makes the rest of the document inert, including PDF frames.
// Browser focus containment also covers dynamically mounted form controls.
export function ModalDialog({ children, className, labelledBy, describedBy, onDismiss }: {
  children: React.ReactNode;
  className: string;
  labelledBy: string;
  describedBy?: string;
  onDismiss: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const opener = document.activeElement;
    const dialog = ref.current;
    dialog?.showModal();
    dialog?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus();
    return () => {
      dialog?.close();
      if (opener instanceof HTMLElement && opener.isConnected) opener.focus();
    };
  }, []);
  return <dialog ref={ref} className={className} aria-labelledby={labelledBy} aria-describedby={describedBy}
    onCancel={event => { event.preventDefault(); onDismiss(); }}>
    {children}
  </dialog>;
}
