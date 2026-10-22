import { expect, test } from "vitest";
import { quickCommandTerminalInput } from "./quickCommands";

test("without trailing newline, last command is only inserted", () => {
  expect(quickCommandTerminalInput("ls")).toBe("ls");
  expect(quickCommandTerminalInput("ls\npwd")).toBe("ls\rpwd");
});

test("trailing newline executes every command exactly once", () => {
  expect(quickCommandTerminalInput("ls\n")).toBe("ls\r");
  expect(quickCommandTerminalInput("ls\npwd\n")).toBe("ls\rpwd\r");
});

test("Windows and Unix line endings are normalized to Enter", () => {
  expect(quickCommandTerminalInput("ls\r\npwd\r\n")).toBe("ls\rpwd\r");
  expect(quickCommandTerminalInput("ls\rpwd")).toBe("ls\rpwd");
});
