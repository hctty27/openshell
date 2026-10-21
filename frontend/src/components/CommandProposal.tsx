import { useState } from "react";
import { Play, Square, ShieldCheck, Check, Clock, Code2 } from "lucide-react";
import type { Proposal } from "../types";
interface Props {
  proposal: Proposal;
  host: string;
  username: string;
  executing: boolean;
  onConfirm(): void;
  onCancel(): void;
  onRevise(command: string, cwd: string, seconds: number): Promise<void>;
}
export default function CommandProposal(p: Props) {
  const [command, setCommand] = useState(p.proposal.command);
  const [cwd, setCwd] = useState(p.proposal.cwd);
  const [seconds, setSeconds] = useState(p.proposal.timeoutSeconds);
  const dirty =
    command !== p.proposal.command ||
    cwd !== p.proposal.cwd ||
    seconds !== p.proposal.timeoutSeconds;
  return (
    <section className="proposal">
      <div className="proposal-heading">
        <Code2 size={15} />
        <span>{p.executing ? "命令执行中" : "待确认的命令"}</span>
        <span className="proposal-badge">SSH</span>
      </div>
      <p>{p.proposal.purpose}</p>
      <div className="proposal-target">
        <ShieldCheck size={13} />
        {p.username}@{p.host}
      </div>
      <textarea
        aria-label="待执行命令"
        className="command-editor"
        value={command}
        disabled={p.executing}
        onChange={(e) => setCommand(e.target.value)}
        spellCheck={false}
      />
      <label className="inline-field">
        目录
        <input
          aria-label="执行工作目录"
          value={cwd}
          disabled={p.executing}
          onChange={(e) => setCwd(e.target.value)}
        />
      </label>
      <label className="inline-field">
        <Clock size={12} />
        <input
          aria-label="命令超时秒数"
          type="number"
          min="1"
          max="600"
          value={seconds}
          disabled={p.executing}
          onChange={(e) => setSeconds(Number(e.target.value))}
        />
        <span>秒</span>
      </label>
      <div className="proposal-actions">
        {p.executing ? (
          <button className="secondary" onClick={p.onCancel}>
            <Square size={12} />
            停止
          </button>
        ) : (
          <>
            <button onClick={p.onCancel}>拒绝</button>
            {dirty ? (
              <button
                className="primary"
                onClick={() => p.onRevise(command, cwd, seconds)}
              >
                <Check size={13} />
                更新提议
              </button>
            ) : (
              <button className="primary" onClick={p.onConfirm}>
                <Play size={13} />
                确认执行
              </button>
            )}
          </>
        )}
      </div>
      <small>独立执行，不继承手动终端的目录和临时状态。</small>
    </section>
  );
}
