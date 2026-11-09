import { renderMessage, type DisplayText } from "../i18n/message";
import ModalSurface from "./ModalSurface";
import { useTranslation } from "react-i18next";
import { t } from "../i18n";
import {
  createContext,
  useCallback,
  useContext,
  useId,
  useRef,
  useState,
  type PropsWithChildren,
} from "react";
import {
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
  cancelLabel?: DisplayText;
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

export interface ChoiceDialogOption {
  value: string;
  label: DisplayText;
  tone?: "default" | "primary" | "warning";
}

export interface ChoiceDialogOptions {
  title: DisplayText;
  description?: DisplayText;
  choices: ChoiceDialogOption[];
  cancelLabel?: DisplayText;
  tone?: "default" | "warning" | "danger";
  preview?: string;
}

interface DialogAPI {
  confirm(options: ConfirmDialogOptions): Promise<boolean>;
  input(options: InputDialogOptions): Promise<string | null>;
  choose(options: ChoiceDialogOptions): Promise<string | null>;
}

type DialogRequestInput =
  | {
      kind: "confirm";
      options: ConfirmDialogOptions;
      resolve(value: boolean): void;
    }
  | {
      kind: "input";
      options: InputDialogOptions;
      resolve(value: string | null): void;
    }
  | {
      kind: "choice";
      options: ChoiceDialogOptions;
      resolve(value: string | null): void;
    };

type DialogRequest = DialogRequestInput & { id: number };

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
  const inputRef = useRef<HTMLInputElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const finished = useRef(false);
  const titleID = useId();
  const descriptionID = useId();
  const isInput = request.kind === "input";
  const isChoice = request.kind === "choice";
  const options = request.options;
  const [value, setValue] = useState(
    isInput ? ((options as InputDialogOptions).defaultValue ?? "") : "",
  );
  const tone = request.kind === "confirm"
    ? request.options.tone ?? "default"
    : request.kind === "choice"
      ? request.options.tone ?? "default"
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

  const cancel = () => complete(isInput || isChoice ? null : false);
  const confirm = () => {
    if (request.kind === "input") {
      const trimmed = value.trim();
      if (trimmed) complete(trimmed);
    } else if (request.kind === "confirm") {
      complete(true);
    }
  };

  const preview = request.kind === "confirm"
    ? request.options.preview
    : request.kind === "choice"
      ? request.options.preview
      : undefined;
  const description = options.description
    ? renderMessage(options.description)
    : undefined;

  return (
    <ModalSurface
      className={"app-dialog app-dialog--" + tone}
      role={tone === "danger" ? "alertdialog" : "dialog"}
      aria-labelledby={titleID}
      aria-describedby={description ? descriptionID : undefined}
      onDismiss={cancel}
      closeOnBackdrop={tone !== "danger"}
      onOpen={() => (isInput ? inputRef.current : cancelRef.current)?.focus()}
    >
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (!isChoice) confirm();
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
        <div className="app-dialog__body">
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
        </div>
        {isChoice ? (
          <div className="app-dialog__actions app-dialog__actions--choices">
            {request.options.choices.map(choice => (
              <button
                key={choice.value}
                type="button"
                className={"app-dialog__choice" + (choice.tone ? " app-dialog__choice--" + choice.tone : "")}
                onClick={() => complete(choice.value)}
              >
                {renderMessage(choice.label)}
              </button>
            ))}
            <button
              type="button"
              ref={cancelRef}
              className="app-dialog__secondary app-dialog__cancel"
              onClick={cancel}
            >
              {request.options.cancelLabel
                ? renderMessage(request.options.cancelLabel)
                : t("common:cancel")}
            </button>
          </div>
        ) : (
          <div className="app-dialog__actions">
            <button
              type="button"
              ref={cancelRef}
              className="app-dialog__secondary"
              onClick={cancel}
            >
              {!isInput && (options as ConfirmDialogOptions).cancelLabel
                ? renderMessage((options as ConfirmDialogOptions).cancelLabel!)
                : t("common:cancel")}
            </button>
            <button
              type="submit"
              className={"app-dialog__primary" + (tone === "danger" ? " app-dialog__primary--danger" : "")}
              disabled={isInput && !value.trim()}
            >
              {request.kind !== "choice" && request.options.confirmLabel
                ? renderMessage(request.options.confirmLabel)
                : isInput
                  ? t("common:ok")
                  : t("common:confirm")}
            </button>
          </div>
        )}
      </form>
    </ModalSurface>
  );
}

export function DialogProvider({ children }: PropsWithChildren) {
  useTranslation();
  const queue = useRef<DialogRequest[]>([]);
  const id = useRef(0);
  const [current, setCurrent] = useState<DialogRequest | null>(null);

  const enqueue = useCallback((request: DialogRequestInput) => {
    queue.current.push({ ...request, id: ++id.current } as DialogRequest);
    if (queue.current.length === 1) setCurrent(queue.current[0]);
  }, []);

  const confirm = useCallback(
    (options: ConfirmDialogOptions): Promise<boolean> =>
      new Promise(resolve => enqueue({ kind: "confirm", options, resolve })),
    [enqueue],
  );

  const input = useCallback(
    (options: InputDialogOptions): Promise<string | null> =>
      new Promise(resolve => enqueue({ kind: "input", options, resolve })),
    [enqueue],
  );

  const choose = useCallback(
    (options: ChoiceDialogOptions): Promise<string | null> =>
      new Promise(resolve => enqueue({ kind: "choice", options, resolve })),
    [enqueue],
  );

  const done = useCallback((result: boolean | string | null) => {
    const request = queue.current.shift();
    if (request?.kind === "confirm") request.resolve(result === true);
    else if (request?.kind === "input" || request?.kind === "choice")
      request.resolve(typeof result === "string" ? result : null);
    setCurrent(queue.current[0] ?? null);
  }, []);

  return (
    <DialogContext.Provider value={{ confirm, input, choose }}>
      {children}
      {current && (
        <DialogContent key={current.id} request={current} onDone={done} />
      )}
    </DialogContext.Provider>
  );
}
