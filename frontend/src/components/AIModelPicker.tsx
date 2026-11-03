import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import { Check, ChevronDown, Cpu, Search } from "lucide-react";
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
  const [query, setQuery] = useState("");
  const [highlighted, setHighlighted] = useState(0);
  const rootRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const listID = useId();

  const options: ModelOption[] = providers.flatMap(provider =>
    provider.models.map(model => ({
      providerID: provider.id, providerName: provider.name,
      modelID: model.id, modelName: model.name || model.id,
    })),
  );
  const selected = options.find(option =>
    option.providerID === providerID && option.modelID === modelID,
  );
  const missing = Boolean(providerID && modelID && !selected);
  const filtered = options.filter(option =>
    `${option.providerName} ${option.modelName} ${option.modelID}`.toLocaleLowerCase()
      .includes(query.trim().toLocaleLowerCase()),
  );

  useEffect(() => {
    if (!open) return;
    setHighlighted(Math.max(0, filtered.findIndex(option =>
      option.providerID === providerID && option.modelID === modelID,
    )));
    searchRef.current?.focus();
  // Reinitialize only when opening, not after each keystroke.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [open]);

  const close = () => {
    setOpen(false);
    setQuery("");
    triggerRef.current?.focus();
  };

  const choose = (option: ModelOption) => {
    onChange(option.providerID, option.modelID);
    close();
  };

  const onSearchKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      close();
    } else if (event.key === "ArrowDown") {
      event.preventDefault();
      setHighlighted(index => Math.min(filtered.length - 1, index + 1));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setHighlighted(index => Math.max(0, index - 1));
    } else if (event.key === "Enter") {
      event.preventDefault();
      const option = filtered[highlighted];
      if (option) choose(option);
    }
  };

  return (
    <div className="ai-model-picker" ref={rootRef}>
      <button ref={triggerRef} type="button"
        className="ai-model-picker__trigger"
        role="combobox" aria-label={t("ai:chooseModel")}
        aria-expanded={open} aria-haspopup="listbox" aria-controls={listID}
        aria-invalid={missing || undefined}
        title={selected ? `${selected.providerName} · ${selected.modelName}` : t("ai:selectModel")}
        disabled={disabled}
        onClick={() => setOpen(value => !value)}
        onKeyDown={event => {
          if (!open && (event.key === "ArrowDown" || event.key === "ArrowUp")) {
            event.preventDefault();
            setOpen(true);
          }
          if (open && event.key === "Escape") { event.preventDefault(); close(); }
        }}>
        <Cpu size={13} aria-hidden="true" />
        <span>{selected ? `${selected.providerName} · ${selected.modelName}` :
          missing ? t("ai:modelUnavailable") : t("ai:selectModel")}</span>
        <ChevronDown size={13} aria-hidden="true" />
      </button>
      {open && (
        <div className="ai-model-picker__popup">
          <label className="ai-model-picker__search">
            <Search size={14} aria-hidden="true" />
            <input ref={searchRef} type="search" aria-label={t("ai:searchApiModel")}
              placeholder={t("ai:searchApiModelPlaceholder")}
              value={query}
              onChange={event => { setQuery(event.target.value); setHighlighted(0); }}
              onKeyDown={onSearchKeyDown} />
          </label>
          <div id={listID} role="listbox" aria-label={t("ai:availableModels")} className="ai-model-picker__options">
            {providers.map(provider => {
              const items = filtered.filter(option => option.providerID === provider.id);
              if (items.length === 0) return null;
              return (
                <div role="group" aria-label={provider.name} key={provider.id}>
                  <div className="ai-model-picker__group-title">{provider.name}</div>
                  {items.map(option => {
                    const isSelected = selected?.providerID === option.providerID &&
                      selected?.modelID === option.modelID;
                    const isHighlighted = filtered[highlighted] === option;
                    return (
                      <button type="button" role="option"
                        aria-selected={isSelected} key={option.modelID}
                        className={[isSelected && "is-selected", isHighlighted && "is-highlighted"].filter(Boolean).join(" ")}
                        onMouseEnter={() => setHighlighted(filtered.indexOf(option))}
                        onClick={() => choose(option)}>
                        <span>{option.modelName}</span>
                        {isSelected && <Check size={14} aria-hidden="true" />}
                      </button>
                    );
                  })}
                </div>
              );
            })}
            {filtered.length === 0 && (
              <p className="ai-muted">{options.length ? t("ai:noMatchingModels") : t("ai:addModelFirst")}</p>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
