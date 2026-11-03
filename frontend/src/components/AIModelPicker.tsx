import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import { Check, ChevronDown, Cpu } from "lucide-react";
import type { AIProvider } from "../types";
import { t } from "../i18n";
import { useTranslation } from "react-i18next";

interface Props {
  providers: AIProvider[];
  providerID: string;
  modelID: string;
  disabled?: boolean;
  onChange(providerID: string, modelID: string): void;
}

type ModelOption = {
  providerID: string;
  providerName: string;
  modelID: string;
  modelName: string;
};

export default function AIModelPicker({ providers, providerID, modelID, disabled, onChange }: Props) {
  useTranslation("ai");
  const [open, setOpen] = useState(false);
  const [highlighted, setHighlighted] = useState(0);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const listID = useId();

  const options: ModelOption[] = providers.flatMap(provider =>
    provider.models.map(model => ({
      providerID: provider.id,
      providerName: provider.name,
      modelID: model.id,
      modelName: model.name || model.id,
    })),
  );
  const selectedIndex = options.findIndex(option =>
    option.providerID === providerID && option.modelID === modelID,
  );
  const selected = options[selectedIndex];
  const missing = Boolean(providerID && modelID && !selected);

  useEffect(() => {
    if (open) setHighlighted(Math.max(0, selectedIndex));
  }, [open, selectedIndex]);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [open]);

  useEffect(() => {
    if (!open || !options.length) return;
    const option = document.getElementById(`${listID}-option-${highlighted}`);
    if (option && typeof option.scrollIntoView === "function") {
      option.scrollIntoView({ block: "nearest" });
    }
  }, [open, highlighted, listID, options.length]);

  const close = () => {
    setOpen(false);
    triggerRef.current?.focus();
  };

  const choose = (option: ModelOption) => {
    onChange(option.providerID, option.modelID);
    close();
  };

  const onTriggerKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (event.key === "Escape" && open) {
      event.preventDefault();
      event.stopPropagation();
      close();
      return;
    }
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (!open) setOpen(true);
      else setHighlighted(index =>
        Math.max(0, Math.min(options.length - 1, index + (event.key === "ArrowDown" ? 1 : -1)))
      );
      return;
    }
    if (open && (event.key === "Home" || event.key === "End")) {
      event.preventDefault();
      setHighlighted(event.key === "Home" ? 0 : Math.max(0, options.length - 1));
      return;
    }
    if (open && (event.key === "Enter" || event.key === " ")) {
      event.preventDefault();
      const option = options[highlighted];
      if (option) choose(option);
    }
  };

  return (
    <div className="ai-model-picker" ref={rootRef}>
      <button ref={triggerRef} type="button"
        className="ai-model-picker__trigger"
        role="combobox" aria-label={t("ai:chooseModel")}
        aria-expanded={open} aria-haspopup="listbox" aria-controls={open ? listID : undefined}
        aria-activedescendant={open && options.length ? `${listID}-option-${highlighted}` : undefined}
        aria-invalid={missing || undefined}
        title={selected ? `${selected.providerName} · ${selected.modelName}` : t("ai:selectModel")}
        disabled={disabled}
        onClick={() => setOpen(value => !value)}
        onKeyDown={onTriggerKeyDown}>
        <Cpu size={13} aria-hidden="true" />
        <span>{selected ? `${selected.providerName} · ${selected.modelName}` :
          missing ? t("ai:modelUnavailable") : t("ai:selectModel")}</span>
        <ChevronDown size={13} aria-hidden="true" />
      </button>
      {open && (
        <div className="ai-model-picker__popup">
          <div id={listID} role="listbox" aria-label={t("ai:availableModels")} className="ai-model-picker__options">
            {options.map((option, index) => {
              const isSelected = index === selectedIndex;
              return (
                <button type="button" role="option"
                  id={`${listID}-option-${index}`}
                  aria-selected={isSelected}
                  key={JSON.stringify([option.providerID, option.modelID])}
                  title={`${option.providerName} · ${option.modelName}`}
                  tabIndex={-1}
                  className={[isSelected && "is-selected", highlighted === index && "is-highlighted"].filter(Boolean).join(" ")}
                  onMouseEnter={() => setHighlighted(index)}
                  onClick={() => choose(option)}>
                  <span>{option.providerName} · {option.modelName}</span>
                  {isSelected && <Check size={14} aria-hidden="true" />}
                </button>
              );
            })}
            {!options.length && <p className="ai-muted">{t("ai:addModelFirst")}</p>}
          </div>
        </div>
      )}
    </div>
  );
}
