import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import { Check, ChevronDown, Cpu, Search } from "lucide-react";
import type { AIProvider } from "../types";

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
        role="combobox" aria-label="选择 AI 模型"
        aria-expanded={open} aria-haspopup="listbox" aria-controls={listID}
        aria-invalid={missing || undefined}
        title={selected ? `${selected.providerName} · ${selected.modelName}` : "选择模型"}
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
          missing ? "模型不可用，请重新选择" : "选择模型"}</span>
        <ChevronDown size={13} aria-hidden="true" />
      </button>
      {open && (
        <div className="ai-model-picker__popup">
          <label className="ai-model-picker__search">
            <Search size={14} aria-hidden="true" />
            <input ref={searchRef} type="search" aria-label="搜索 API 或模型"
              placeholder="搜索 API 或模型..."
              value={query}
              onChange={event => { setQuery(event.target.value); setHighlighted(0); }}
              onKeyDown={onSearchKeyDown} />
          </label>
          <div id={listID} role="listbox" aria-label="可用 AI 模型" className="ai-model-picker__options">
            {providers.map(provider => {
              const items = filtered.filter(option => option.providerID === provider.id);
              if (items.length === 0) return null;
              return (
                <div role="group" aria-label={provider.name} key={provider.id}>
                  <div className="ai-model-picker__group-title">{provider.name}</div>
                  {items.map(option => {
                    const isSelected = selected?.providerID === option.providerID &&
                      selected?.modelID === option.modelID;
                    return (
                      <button type="button" role="option"
                        aria-selected={isSelected} key={option.modelID}
                        className={isSelected ? "is-selected" : ""}
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
              <p className="ai-muted">{options.length ? "没有匹配的模型" : "请先在全局设置中添加 AI 模型"}</p>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
