import { expect, test } from "vitest";
import { resolveSFTPInitialDirectory } from "./sftpDirectory";

test("first SFTP open starts at the reported terminal directory", () => {
  expect(resolveSFTPInitialDirectory(undefined, {
    cwd: "/opt/project",
    cwdReported: true,
  })).toBe("/opt/project");
});

test("first SFTP open uses the cloned cwd before the terminal reports its directory", () => {
  expect(resolveSFTPInitialDirectory(undefined, {
    cwd: "/root",
    cwdReported: false,
    cloneCwd: "/opt/project",
  })).toBe("/opt/project");
});

test("reopening SFTP restores its last directory even after terminal cwd changes", () => {
  const remembered = "/opt/project/logs";
  expect(resolveSFTPInitialDirectory(remembered, {
    cwd: "/home",
    cwdReported: true,
  })).toBe(remembered);
});

test("a new SSH tab does not inherit another tab's remembered directory", () => {
  const rememberedByTab: Record<string, string> = { "tab-a": "/opt/project/logs" };
  const currentTab = { cwd: "/home", cwdReported: true };

  expect(resolveSFTPInitialDirectory(rememberedByTab["tab-a"], currentTab))
    .toBe("/opt/project/logs");
  expect(resolveSFTPInitialDirectory(rememberedByTab["tab-b"], currentTab))
    .toBe("/home");
});

test("an empty remembered path falls back to the terminal directory", () => {
  expect(resolveSFTPInitialDirectory("", {
    cwd: "/opt/project",
    cwdReported: true,
  })).toBe("/opt/project");
});
