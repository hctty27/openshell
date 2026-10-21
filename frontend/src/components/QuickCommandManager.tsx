import { useState } from "react";
import { ArrowDown, ArrowUp, Plus, Save, Trash2, X } from "lucide-react";
import type { Group, QuickCommand, Session } from "../types";
import { errorText } from "../bridge";
import { useDialogs } from "./DialogProvider";

interface Props {
  commands: QuickCommand[];
  groups: Group[];
  sessions: Session[];
  onSave(commands: QuickCommand[]): Promise<void>;
  onClose(): void;
}

const empty = (): QuickCommand => ({
  id: "",
  name: "",
  command: "",
  category: "常用",
  scope: "global",
  scopeId: "",
  mode: "run",
  confirm: false,
});

export default function QuickCommandManager(p: Props) {
  const dialogs = useDialogs();
  const [draft, setDraft] = useState<QuickCommand>(empty);
  const [category, setCategory] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const categories = [...new Set(p.commands.map((c) => c.category || "常用"))];
  const listed = p.commands.filter((c) => !category || (c.category || "常用") === category);
  const edit = (command: QuickCommand) => {
    setDraft({ ...command });
    setError("");
    setSuccess("");
  };
  const persist = async (next: QuickCommand[], message: string) => {
    setBusy(true);
    setError("");
    setSuccess("");
    try {
      await p.onSave(next);
      setSuccess(message);
      return true;
    } catch (e) {
      setError(errorText(e));
      return false;
    } finally {
      setBusy(false);
    }
  };
  const save = async () => {
    const item = { ...draft, name: draft.name.trim(), category: draft.category.trim() || "常用" };
    if (!item.name || Array.from(item.name).length > 40) {
      setError("名称必须为 1–40 个字符");
      return;
    }
    if (!item.command || item.command.length > 4096 || /[\r\n\x00]/.test(item.command)) {
      setError("命令必须是非空单行文本，且不能超过 4096 字符");
      return;
    }
    if (Array.from(item.category).length > 40) {
      setError("分类最多 40 个字符");
      return;
    }
    if (item.scope !== "global" && !item.scopeId) {
      setError("请选择目标会话或分组");
      return;
    }
    if (!item.id && p.commands.length >= 200) {
      setError("最多保存 200 条命令");
      return;
    }
    if (!item.id) item.id = crypto.randomUUID();
    const next = draft.id
      ? p.commands.map((c) => c.id === draft.id ? item : c)
      : [...p.commands, item];
    if (await persist(next, "命令已保存")) setDraft(empty());
  };
  const remove = async (item: QuickCommand) => {
    if (!(await dialogs.confirm({
      title: "删除快速命令",
      description: `确定删除「${item.name}」？此操作无法撤销。`,
      tone: "danger",
      confirmLabel: "删除命令",
    }))) return;
    if (await persist(p.commands.filter((c) => c.id !== item.id), "命令已删除")) {
      if (draft.id === item.id) setDraft(empty());
    }
  };
  const move = async (item: QuickCommand, direction: -1 | 1) => {
    const i = p.commands.findIndex((c) => c.id === item.id);
    const filteredIndex = listed.findIndex((c) => c.id === item.id);
    const neighbor = listed[filteredIndex + direction];
    const j = neighbor ? p.commands.findIndex((c) => c.id === neighbor.id) : -1;
    if (i < 0 || j < 0) return;
    const next = [...p.commands];
    [next[i], next[j]] = [next[j], next[i]];
    await persist(next, "顺序已更新");
  };
  return (
    <div className="modal-backdrop" onMouseDown={(e) => {
      if (e.target === e.currentTarget && !busy) p.onClose();
    }}>
      <section role="dialog" aria-modal="true" aria-label="管理快速命令" className="quick-manager">
        <header className="quick-manager-header">
          <div>
            <span className="eyebrow">QUICK COMMANDS</span>
            <h2>管理快速命令</h2>
          </div>
          <button title="关闭" disabled={busy} onClick={p.onClose}><X size={19}/></button>
        </header>
        <div className="quick-manager-body">
          <aside className="quick-manager-side">
            <div className="quick-manager-side-head">
              <strong>命令列表 ({p.commands.length})</strong>
              <button title="新增命令" disabled={busy} onClick={() => edit(empty())}><Plus size={16}/></button>
            </div>
            <select value={category} onChange={(e) => setCategory(e.target.value)} aria-label="筛选命令分类">
              <option value="">全部分类</option>
              {categories.map((c) => <option key={c} value={c}>{c}</option>)}
            </select>
            <div className="quick-manager-items">
              {listed.length === 0 && <p className="muted small">暂无命令</p>}
              {listed.map((item) => (
                <div key={item.id} className={`quick-manager-item ${draft.id === item.id ? "selected" : ""}`}>
                  <button className="quick-manager-item-label" disabled={busy} onClick={() => edit(item)}>
                    <strong>{item.name}</strong>
                    <small>{item.category || "常用"} · {item.scope === "global" ? "全局" : item.scope === "group" ? "分组" : "会话"}</small>
                  </button>
                  <button title="上移" disabled={busy || listed[0]?.id === item.id} onClick={() => move(item, -1)}><ArrowUp size={13}/></button>
                  <button title="下移" disabled={busy || listed.at(-1)?.id === item.id} onClick={() => move(item, 1)}><ArrowDown size={13}/></button>
                </div>
              ))}
            </div>
          </aside>
          <div className="quick-manager-editor">
            <h3>{draft.id ? "编辑命令" : "新增命令"}</h3>
            <label>按钮名称
              <input value={draft.name} maxLength={40} onChange={(e) => setDraft({ ...draft, name: e.target.value })} placeholder="如：查看内存"/>
            </label>
            <label>命令内容
              <textarea rows={3} value={draft.command} onChange={(e) => setDraft({ ...draft, command: e.target.value })} placeholder="如：free -h"/>
            </label>
            <div className="quick-manager-fields">
              <label>命令分类
                <input list="quick-command-categories" value={draft.category} maxLength={40} onChange={(e) => setDraft({ ...draft, category: e.target.value })}/>
                <datalist id="quick-command-categories">{categories.map((c) => <option key={c} value={c}/>)}</datalist>
              </label>
              <label>作用范围
                <select value={draft.scope} onChange={(e) => setDraft({ ...draft, scope: e.target.value as QuickCommand["scope"], scopeId: "" })}>
                  <option value="global">所有服务器</option>
                  <option value="group">指定服务器分组</option>
                  <option value="session">指定 SSH 会话</option>
                </select>
              </label>
            </div>
            {draft.scope === "group" && (
              <label>目标分组
                <select value={draft.scopeId} onChange={(e) => setDraft({ ...draft, scopeId: e.target.value })}>
                  <option value="">请选择分组</option>
                  {p.groups.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
                </select>
              </label>
            )}
            {draft.scope === "session" && (
              <label>目标会话
                <select value={draft.scopeId} onChange={(e) => setDraft({ ...draft, scopeId: e.target.value })}>
                  <option value="">请选择会话</option>
                  {p.sessions.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                </select>
              </label>
            )}
            <label>点击后的操作
              <select value={draft.mode} onChange={(e) => setDraft({ ...draft, mode: e.target.value as QuickCommand["mode"] })}>
                <option value="run">发送并执行</option>
                <option value="insert">只填入终端，不执行</option>
              </select>
            </label>
            <label className="checkbox">
              <input type="checkbox" checked={draft.confirm} onChange={(e) => setDraft({ ...draft, confirm: e.target.checked })}/>
              每次执行前确认
            </label>
            <p className="muted small">命令将发送给当前 SSH 终端。请先退出 vim、top 等交互程序再执行；危险命令建议开启确认。</p>
            {error && <p className="form-error" role="alert">{error}</p>}
            {success && <p className="form-success">{success}</p>}
            <div className="quick-manager-actions">
              {draft.id && <button className="danger" disabled={busy} onClick={() => remove(draft)}><Trash2 size={15}/> 删除</button>}
              <button className="secondary" disabled={busy} onClick={() => edit(empty())}><Plus size={15}/> 新建</button>
              <button className="primary" disabled={busy || !draft.name.trim() || !draft.command} onClick={save}><Save size={15}/> 保存命令</button>
            </div>
          </div>
        </div>
      </section>
    </div>
  );
}
