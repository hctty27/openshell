import { beforeEach, expect, test } from "vitest";
import {
  DEFAULT_SFTP_EDITOR_PREFERENCES,
  detectIndentation,
  readSFTPEditorPreferences,
  writeSFTPEditorPreferences,
} from "./sftpEditorPreferences";

beforeEach(() => localStorage.clear());

test("defaults to automatically detected indentation with readable code settings", () => {
  expect(readSFTPEditorPreferences()).toEqual(DEFAULT_SFTP_EDITOR_PREFERENCES);
});

test("detects tabs and common space indentation", () => {
  expect(detectIndentation("\tserver {\n\t\tlisten 80;\n}", 4)).toEqual({ mode: "tabs", size: 4 });
  expect(detectIndentation("root:\n    value: 1\n    another: 2\n", 4)).toEqual({ mode: "spaces", size: 4 });
  expect(detectIndentation("root:\n  value: 1\n  another: 2\n", 4)).toEqual({ mode: "spaces", size: 2 });
});

test("persists preferences but ignores malformed stored settings", () => {
  writeSFTPEditorPreferences({ ...DEFAULT_SFTP_EDITOR_PREFERENCES, indentMode: "tabs", indentSize: 8, wordWrap: true });
  expect(readSFTPEditorPreferences()).toMatchObject({ indentMode: "tabs", indentSize: 8, wordWrap: true });
  localStorage.setItem("openshell.sftp.editor.preferences", "{\"indentMode\":\"broken\",\"indentSize\":7}");
  expect(readSFTPEditorPreferences()).toMatchObject({ indentMode: "auto", indentSize: 4 });
});
