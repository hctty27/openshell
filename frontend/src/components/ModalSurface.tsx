import { useEffect, useRef, type DialogHTMLAttributes, type ReactNode } from "react";

interface ModalSurfaceProps extends Omit<DialogHTMLAttributes<HTMLDialogElement>, "onClose" | "onCancel"> {
  children: ReactNode;
  onDismiss(): void;
  locked?: boolean;
  closeOnBackdrop?: boolean;
  onOpen?(): void;
}

/**
 * Shared native modal: browser-managed top layer, focus containment and
 * Escape handling. The previous focus target is restored on unmount.
 */
export default function ModalSurface({
  children,
  className = "",
  onDismiss,
  locked = false,
  closeOnBackdrop = true,
  onOpen,
  ...attributes
}: ModalSurfaceProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    if (typeof dialog.showModal === "function") dialog.showModal();
    else dialog.setAttribute("open", "");
    onOpen?.();
    return () => {
      if (dialog.open && typeof dialog.close === "function") dialog.close();
      else dialog.removeAttribute("open");
      if (previous?.isConnected) previous.focus();
    };
  }, []);

  return (
    <dialog
      {...attributes}
      ref={dialogRef}
      className={`modal-surface ${className}`.trim()}
      aria-modal="true"
      onCancel={(event) => {
        event.preventDefault();
        if (!locked) onDismiss();
      }}
      onClick={(event) => {
        if (locked || !closeOnBackdrop || event.target !== event.currentTarget) return;
        const bounds = event.currentTarget.getBoundingClientRect();
        if (
          event.clientX < bounds.left || event.clientX > bounds.right ||
          event.clientY < bounds.top || event.clientY > bounds.bottom
        ) onDismiss();
      }}
    >
      {children}
    </dialog>
  );
}
