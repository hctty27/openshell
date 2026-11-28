import { useEffect, useRef, useState } from "react";
import { FileText, Save, Search, X, WrapText } from "lucide-react";
import { EditorState, Compartment, Prec } from "@codemirror/state";
import { EditorView, basicSetup } from "codemirror";
import { keymap } from "@codemirror/view";
import { indentWithTab, toggleComment } from "@codemirror/commands";
import { indentUnit, LanguageDescription } from "@codemirror/language";
import { openSearchPanel, search, gotoLine } from "@codemirror/search";
import { sftpLanguages } from "./sftpLanguages";
import { detectLineEnding, normalizeLineEndings, serializeLineEndings } from "./sftpEditorLineEndings";
import { i18n, t } from "../../i18n";
import {
  detectIndentation,
  readSFTPEditorPreferences,
  writeSFTPEditorPreferences,
  type IndentSize,
  type SFTPEditorPreferences,
} from "./sftpEditorPreferences";

interface Props {
  path: string;
  initialContent: string;
  dirty: boolean;
  saving: boolean;
  onChange(content: string): void;
  onSave(content: string): void;
  onClose(): void;
  active: boolean;
}

const displayIndent = (value: { mode: "spaces" | "tabs"; size: IndentSize }) =>
  (value.mode === "tabs" ? "Tab" : t("sftp:editorSpaces")) + ": " + value.size;

export default function SFTPFileEditor({
  path, initialContent, dirty, saving, onChange, onSave, onClose, active,
}: Props) {
  const hostRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const actionsRef = useRef({ onChange, onSave });
  actionsRef.current = { onChange, onSave };
  const [preferences, setPreferences] = useState(readSFTPEditorPreferences);
  const [cursor, setCursor] = useState({ line: 1, column: 1 });
  const [languageName, setLanguageName] = useState(t("sftp:editorPlainText"));
  const initialRef = useRef(initialContent);
  const originalLineEnding = detectLineEnding(initialRef.current);
  const indentation = preferences.indentMode === "auto"
    ? detectIndentation(initialRef.current, preferences.indentSize)
    : { mode: preferences.indentMode, size: preferences.indentSize };

  const wrapCompartment = useRef(new Compartment());
  const indentCompartment = useRef(new Compartment());
  const tabCompartment = useRef(new Compartment());
  const languageCompartment = useRef(new Compartment());
  const syntaxSupport = useRef<Awaited<ReturnType<LanguageDescription["load"]>> | null>(null);

  useEffect(() => {
    const parent = hostRef.current;
    if (!parent) return;
    const current = readSFTPEditorPreferences();
    const resolved = current.indentMode === "auto"
      ? detectIndentation(initialRef.current, current.indentSize)
      : { mode: current.indentMode, size: current.indentSize };
    const onSaveKey = (view: EditorView) => {
      actionsRef.current.onSave(serializeLineEndings(view.state.doc.toString(), originalLineEnding));
      return true;
    };
    const view = new EditorView({
      parent,
      state: EditorState.create({
        doc: normalizeLineEndings(initialRef.current),
        extensions: [
          basicSetup,
          search({ top: true }),
          EditorState.phrases.of({
            "Find": i18n.t("sftp:editorFind"),
            "Replace": i18n.t("sftp:editorReplaceField"),
            "next": i18n.t("sftp:editorNext"),
            "previous": i18n.t("sftp:editorPrevious"),
            "all": i18n.t("sftp:editorAll"),
            "match case": i18n.t("sftp:editorMatchCase"),
            "regexp": i18n.t("sftp:editorRegexp"),
            "by word": i18n.t("sftp:editorByWord"),
            "replace": i18n.t("sftp:editorReplace"),
            "replace all": i18n.t("sftp:editorReplaceAll"),
            "close": i18n.t("sftp:editorClose"),
            "Go to line": i18n.t("sftp:editorGoToLine"),
            "Go": i18n.t("sftp:editorGo"),
          }),
          Prec.high(keymap.of([
            { key: "Mod-s", run: onSaveKey },
            { key: "Mod-h", run: openSearchPanel },
            { key: "Mod-g", run: gotoLine },
            { key: "Mod-/", run: toggleComment },
            indentWithTab,
          ])),
          EditorView.clipboardInputFilter.of(normalizeLineEndings),
          indentCompartment.current.of(indentUnit.of(resolved.mode === "tabs" ? "\t" : " ".repeat(resolved.size))),
          tabCompartment.current.of(EditorState.tabSize.of(resolved.size)),
          wrapCompartment.current.of(current.wordWrap ? EditorView.lineWrapping : []),
          languageCompartment.current.of([]),
          EditorView.contentAttributes.of({ "aria-label": t("sftp:editText"), spellcheck: "false" }),
          EditorView.updateListener.of(update => {
            if (update.docChanged) actionsRef.current.onChange(serializeLineEndings(update.state.doc.toString(), originalLineEnding));
            if (update.selectionSet || update.docChanged) {
              const point = update.state.selection.main.head;
              const line = update.state.doc.lineAt(point);
              setCursor({ line: line.number, column: point - line.from + 1 });
            }
          }),
        ],
      }),
    });
    viewRef.current = view;
    let alive = true;
    const description = LanguageDescription.matchFilename(sftpLanguages, path);
    if (description) {
      setLanguageName(description.name);
      void description.load().then(support => {
        if (!alive) return;
        syntaxSupport.current = support;
        if (readSFTPEditorPreferences().syntaxHighlight) {
          view.dispatch({ effects: languageCompartment.current.reconfigure(support) });
        }
      }).catch(() => setLanguageName(t("sftp:editorPlainText")));
    }
    return () => {
      alive = false;
      viewRef.current = null;
      view.destroy();
    };
  }, [path]);

  useEffect(() => {
    const view = viewRef.current;
    if (!view || !active) return;
    view.requestMeasure();
    view.focus();
  }, [active]);

  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    const resolved = preferences.indentMode === "auto"
      ? detectIndentation(initialRef.current, preferences.indentSize)
      : { mode: preferences.indentMode, size: preferences.indentSize };
    view.dispatch({
      effects: [
        indentCompartment.current.reconfigure(indentUnit.of(resolved.mode === "tabs" ? "\t" : " ".repeat(resolved.size))),
        tabCompartment.current.reconfigure(EditorState.tabSize.of(resolved.size)),
        wrapCompartment.current.reconfigure(preferences.wordWrap ? EditorView.lineWrapping : []),
        languageCompartment.current.reconfigure(preferences.syntaxHighlight && syntaxSupport.current ? syntaxSupport.current : []),
      ],
    });
  }, [preferences]);

  const changePreferences = (patch: Partial<SFTPEditorPreferences>) => {
    const next = { ...preferences, ...patch };
    setPreferences(next);
    writeSFTPEditorPreferences(next);
  };
  const changeIndent = (value: string) => {
    if (value === "auto") return changePreferences({ indentMode: "auto" });
    const [mode, size] = value.split(":");
    changePreferences({ indentMode: mode as "spaces" | "tabs", indentSize: Number(size) as IndentSize });
  };
  const indentValue = preferences.indentMode === "auto" ? "auto" : preferences.indentMode + ":" + preferences.indentSize;
  const newline = originalLineEnding === "\r\n" ? "CRLF" : originalLineEnding === "\r" ? "CR" : "LF";

  return (
    <section className="sftp-editor">
        <header>
          <strong title={path}><FileText size={15} /><span>{path}</span>{dirty && <span className="sftp-editor-dirty" title={t("sftp:editorUnsaved")}>●</span>}</strong>
          <div className="sftp-editor-tools">
            <button type="button" title={t("sftp:editorSearchReplace")} onClick={() => { const view = viewRef.current; if (view) openSearchPanel(view); }}><Search size={16} /></button>
            <button type="button" title={t("sftp:saveFile")} disabled={saving || !dirty} onClick={() => onSave(serializeLineEndings(viewRef.current?.state.doc.toString() ?? normalizeLineEndings(initialRef.current), originalLineEnding))}><Save size={16} /></button>
            <button type="button" title={t("common:close")} disabled={saving} onClick={onClose}><X size={17} /></button>
          </div>
        </header>
        <div className={"sftp-cm-host" + (preferences.lineNumbers ? "" : " sftp-cm-no-lines")} ref={hostRef} />
        <div className="sftp-editor-status">
          <span>{t("sftp:editorCursor", cursor)}</span>
          <span>UTF-8</span>
          <span>{newline}</span>
          <button type="button" onClick={() => changePreferences({ wordWrap: !preferences.wordWrap })} title={t("sftp:editorWordWrap")} aria-pressed={preferences.wordWrap}><WrapText size={13} /> {t("sftp:editorWordWrap")}</button>
          <select aria-label={t("sftp:editorIndent")} value={indentValue} onChange={event => changeIndent(event.target.value)}>
            <option value="auto">{t("sftp:editorAutoIndent")} ({displayIndent(indentation)})</option>
            {[2, 4, 8].flatMap(size => ([
              <option key={"spaces" + size} value={"spaces:" + size}>{t("sftp:editorSpaces")}: {size}</option>,
              <option key={"tabs" + size} value={"tabs:" + size}>Tab: {size}</option>,
            ]))}
          </select>
          <span>{preferences.syntaxHighlight ? languageName : t("sftp:editorPlainText")}</span>
        </div>
        <footer>
          <small>{t("sftp:utf8EditorLimit")}</small>
          <button type="button" disabled={saving} onClick={onClose}>{t("common:cancel")}</button>
          <button type="button" disabled={saving || !dirty} className="sftp-editor-save" onClick={() => onSave(serializeLineEndings(viewRef.current?.state.doc.toString() ?? normalizeLineEndings(initialRef.current), originalLineEnding))}><Save size={14} />{t("sftp:saveFile")}</button>
        </footer>
    </section>
  );
}
