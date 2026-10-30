# OpenShell Native 2.0 — Windows release acceptance

This is an executable human QA checklist, not a claim that GUI testing passed.

## Build gate
- [ ] PR head is identical to the SHA in the successful Native Rust, CI and
      SSH / lrzsz workflows.
- [ ] Windows Release unsigned preview launches and `--diagnose` passes.
- [ ] Test real GUI, not merely a compile or command-line diagnostic.

## Terminal input and rendering
- [ ] Microsoft Pinyin: type `你好世界`, select candidates by number/Space,
      Enter confirms exactly once and Esc cancels without PTY input.
- [ ] AltGr (@, €), combining marks, emoji, ASCII, Ctrl+C and clipboard work.
- [ ] Switching tabs, session editor fields and both split panes during an IME
      composition neither leaks text to another session nor loses the next key.
- [ ] Mouse selection, CJK widths, window resize, horizontal/vertical split
      and terminal scrollbar match the grid at 100%, 125%, 150%, 200% scaling.
- [ ] Open/close SFTP dock while SSH is connected; correct terminal columns
      and scrollback must be preserved.
- [ ] Test PowerShell, remote bash/zsh, vim/less, tmux and interactive AI CLIs.

## SSH and file transfer
- [ ] Host key pinning/rejection, password/private-key session, reconnect,
      connection loss, multiple independent tabs and app exit are correct.
- [ ] SFTP navigation and upload/download/cancel, including Chinese names,
      large files, permissions and SHA-256 comparison.
- [ ] Real GUI rz/sz upload/download/cancel with a remote Linux host; compare
      SHA-256 and confirm the shell recovers without binary output leakage.

**Release policy:** keep PR #88 Draft, main unchanged and no production
release until these items have recorded PASS results on Windows. Green CI
cannot replace actual IME, DPI, mouse and network-interruption acceptance.
