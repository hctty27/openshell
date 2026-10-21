import { renderMessage, type DisplayText } from "../i18n/message";
import { useTranslation } from "react-i18next";
import { t } from "../i18n";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useRef,
  useState,
  type PropsWithChildren,
} from "react";
import {
  AlertTriangle,
  FolderPlus,
  Info,
  Pencil,
  ShieldAlert,
  Trash2,
  X,
} from "lucide-react";

export interface ConfirmDialogOptions {
  title: DisplayText;
  description: DisplayText;
  confirmLabel?: DisplayText;
  tone?: "default" | "warning" | "danger";
  preview?: string;
}

export interface InputDialogOptions {
  icon?: "rename" | "create";
  title: DisplayText;
  description?: DisplayText;
  label: DisplayText;
  defaultValue?: string;
  placeholder?: DisplayText;
  confirmLabel?: DisplayText;
}

interface DialogAPI {
  confirm(options: ConfirmDialogOptions): Promise<boolean>;
  input(options: InputDialogOptions): Promise<string | null>;
}

type DialogRequest =
  | {
      id: number;
      kind: "confirm";
      options: ConfirmDialogOptions;
      resolve(value: boolean): void;
    }
  | {
      id: number;
      kind: "input";
      options: InputDialogOptions;
      resolve(value: string | null): void;
    };

const DialogContext = createContext<DialogAPI | null>(null);

export function useDialogs(): DialogAPI {
  const context = useContext(DialogContext);
  if (!context)
    throw new Error("useDialogs must be used inside DialogProvider");
  return context;
}

function DialogContent({
  request,
  onDone,
}: {
  request: DialogRequest;
  onDone(result: boolean | string | null): void;
}) {
  useTranslation();
  const dialogRef = useRef<HTMLDialogElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const finished = useRef(false);
  const titleID = useId();
  const descriptionID = useId();
  const isInput = request.kind === "input";
  const options = request.options;
  const [value, setValue] = useState(
    isInput ? ((options as InputDialogOptions).defaultValue ?? "") : "",
  );
  const tone = !isInput
    ? ((options as ConfirmDialogOptions).tone ?? "default")
    : "default";
  const Icon = isInput
    ? (options as InputDialogOptions).icon === "rename"
      ? Pencil
      : FolderPlus
    : tone === "danger"
      ? Trash2
      : tone === "warning"
        ? ShieldAlert
        : Info;

  const complete = (result: boolean | string | null) => {
    if (finished.current) return;
    finished.current = true;
    onDone(result);
  };

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (typeof dialog.showModal === "function") dialog.showModal();
    else dialog.setAttribute("open", "");
    (isInput ? inputRef.current : cancelRef.current)?.focus();
    return () => {
      if (typeof dialog.close === "function" && dialog.open) dialog.close();
    };
  }, [isInput]);

  const cancel = () => complete(isInput ? null : false);
  const confirm = () => {
    if (request.kind === "input") {
      const trimmed = value.trim();
      if (trimmed) complete(trimmed);
    } else {
      complete(true);
    }
  };

  const preview =
    request.kind === "confirm" ? request.options.preview : undefined;
  const description = options.description
    ? renderMessage(options.description)
    : undefined;

  return (
    <dialog
      ref={dialogRef}
      className={`app-dialog app-dialog--${tone}`}
      role={tone === "danger" ? "alertdialog" : "dialog"}
      aria-modal="true"
      aria-labelledby={titleID}
      aria-describedby={description ? descriptionID : undefined}
      onCancel={(event) => {
        event.preventDefault();
        cancel();
      }}
      onClick={(event) => {
        if (event.target === event.currentTarget) cancel();
      }}
    >
      <form
        onSubmit={(event) => {
          event.preventDefault();
          confirm();
        }}
      >
        <div className="app-dialog__header">
          <span className="app-dialog__icon" aria-hidden="true">
            <Icon size={19} />
          </span>
          <h2 id={titleID}>{renderMessage(options.title)}</h2>
          <button
            type="button"
            className="app-dialog__close"
            aria-label={t("common:closeDialog")}
            onClick={cancel}
          >
            <X size={18} />
          </button>
        </div>
        {description && (
          <p id={descriptionID} className="app-dialog__description">
            {description}
          </p>
        )}
        {request.kind === "input" ? (
          <label className="app-dialog__field">
            <span>{renderMessage(request.options.label)}</span>
            <input
              ref={inputRef}
              value={value}
              onChange={(event) => setValue(event.target.value)}
              placeholder={
                request.options.placeholder
                  ? renderMessage(request.options.placeholder)
                  : undefined
              }
              autoComplete="off"
              autoFocus
            />
          </label>
        ) : preview !== undefined ? (
          <div className="app-dialog__preview">
            <pre>
              {preview.length > 4000
                ? t("common:previewTruncated", { text: preview.slice(0, 4000) })
                : preview}
            </pre>
            {preview.includes("\n") && (
              <small>
                {t("common:lineCount", {
                  count: preview.split(/\r\n|\n|\r/).length,
                })}
              </small>
            )}
          </div>
        ) : null}
        <div className="app-dialog__actions">
          <button
            type="button"
            ref={cancelRef}
            className="app-dialog__secondary"
            onClick={cancel}
          >
            {t("common:cancel")}
          </button>
          <button
            type="submit"
            className={`app-dialog__primary ${tone === "danger" ? "app-dialog__primary--danger" : ""}`}
            disabled={isInput && !value.trim()}
          >
            {options.confirmLabel
              ? renderMessage(options.confirmLabel)
              : isInput
                ? t("common:ok")
                : t("common:confirm")}
          </button>
        </div>
      </form>
    </dialog>
  );
}

export function DialogProvider({ children }: PropsWithChildren) {
  useTranslation();
  const queue = useRef<DialogRequest[]>([]);
  const id = useRef(0);
  const [current, setCurrent] = useState<DialogRequest | null>(null);

  const confirm = useCallback(
    (options: ConfirmDialogOptions): Promise<boolean> =>
      new Promise((resolve) => {
        queue.current.push({
          id: ++id.current,
          kind: "confirm",
          options,
          resolve,
        });
        if (queue.current.length === 1) setCurrent(queue.current[0]);
      }),
    [],
  );

  const input = useCallback(
    (options: InputDialogOptions): Promise<string | null> =>
      new Promise((resolve) => {
        queue.current.push({
          id: ++id.current,
          kind: "input",
          options,
          resolve,
        });
        if (queue.current.length === 1) setCurrent(queue.current[0]);
      }),
    [],
  );

  const done = useCallback((result: boolean | string | null) => {
    const request = queue.current.shift();
    if (request?.kind === "confirm") request.resolve(result === true);
    else if (request?.kind === "input")
      request.resolve(typeof result === "string" ? result : null);
    setCurrent(queue.current[0] ?? null);
  }, []);

  return (
    <DialogContext.Provider value={{ confirm, input }}>
      {children}
      {current && (
        <DialogContent key={current.id} request={current} onDone={done} />
      )}
    </DialogContext.Provider>
  );
}
