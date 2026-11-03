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
function outsideDialog(dialog: HTMLDialogElement, x: number, y: number): boolean {
  const bounds = dialog.getBoundingClientRect();
  return x < bounds.left || x > bounds.right || y < bounds.top || y > bounds.bottom;
}

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
  const pressedOnBackdrop = useRef(false);
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
      onPointerDown={(event) => {
        pressedOnBackdrop.current = event.button === 0 &&
          event.target === event.currentTarget &&
          outsideDialog(event.currentTarget, event.clientX, event.clientY);
      }}
      onPointerCancel={() => { pressedOnBackdrop.current = false; }}
      onClick={(event) => {
        const startedOnBackdrop = pressedOnBackdrop.current;
        pressedOnBackdrop.current = false;
        if (locked || !closeOnBackdrop || !startedOnBackdrop ||
            event.target !== event.currentTarget) return;
        if (outsideDialog(event.currentTarget, event.clientX, event.clientY)) onDismiss();
      }}
    >
      {children}
    </dialog>
  );
}
