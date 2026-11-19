import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { expect, test } from "vitest";
import { detectLineEnding, normalizeLineEndings, serializeLineEndings } from "./sftpEditorLineEndings";

test("recognizes LF, CRLF, CR, and empty files", () => {
  expect(detectLineEnding("a\nb")).toBe("\n");
  expect(detectLineEnding("a\r\nb")).toBe("\r\n");
  expect(detectLineEnding("a\rb")).toBe("\r");
  expect(detectLineEnding("")).toBe("\n");
});

test("normalizes mixed clipboard line endings without changing tabs or blank lines", () => {
  const pasted = "server 127.0.0.1:8212;\r\n\r\n\tserver 127.0.0.1:8213;\rserver 127.0.0.1:8214;\n";
  expect(normalizeLineEndings(pasted)).toBe("server 127.0.0.1:8212;\n\n\tserver 127.0.0.1:8213;\nserver 127.0.0.1:8214;\n");
  expect(normalizeLineEndings(pasted)).not.toContain("\r");
});

test("round trips original CRLF and CR files without changing their line breaks", () => {
  for (const source of ["server {\r\n\tlisten 80;\r\n}\r\n", "server {\r\tlisten 80;\r}\r"]) {
    const lineEnding = detectLineEnding(source);
    expect(serializeLineEndings(normalizeLineEndings(source), lineEnding)).toBe(source);
  }
});

test("preserves LF files, trailing newline, and text without final newline", () => {
  expect(serializeLineEndings("one\ntwo\n", "\n")).toBe("one\ntwo\n");
  expect(serializeLineEndings("one\r\ntwo", "\n")).toBe("one\ntwo");
  expect(serializeLineEndings("one\ntwo", "\r\n")).toBe("one\r\ntwo");
});

test("CodeMirror clipboard input filter strips stray CR before insert and save", () => {
  const source = "before\n";
  const state = EditorState.create({
    doc: normalizeLineEndings(source),
    extensions: [EditorView.clipboardInputFilter.of(normalizeLineEndings)],
  });
  const incoming = "server 127.0.0.1:8212;\r\n\r\nserver 127.0.0.1:8213;\r\n";
  const pasted = state.facet(EditorView.clipboardInputFilter).reduce(
    (text, filter) => filter(text, state),
    incoming,
  );
  const next = state.update({ changes: { from: state.doc.length, insert: pasted } }).state;
  expect(next.doc.toString()).toBe("before\nserver 127.0.0.1:8212;\n\nserver 127.0.0.1:8213;\n");
  expect(serializeLineEndings(next.doc.toString(), detectLineEnding(source))).not.toContain("\r");
});
