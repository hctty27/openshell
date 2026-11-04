import { afterEach, expect, test } from "vitest";
import { readAIExecutionMode, saveAIExecutionMode } from "./executionModePreference";

afterEach(() => {
  window.localStorage.removeItem("openshell.ai.execution-mode.global");
  window.localStorage.removeItem("openshell.ai.execution-mode.terminal");
});

test("review is the safe initial mode for both AI surfaces", () => {
  expect(readAIExecutionMode(false)).toBe("review");
  expect(readAIExecutionMode(true)).toBe("review");
});

test("global and terminal modes are saved independently", () => {
  saveAIExecutionMode(false, "auto");
  expect(readAIExecutionMode(false)).toBe("auto");
  expect(readAIExecutionMode(true)).toBe("review");
  saveAIExecutionMode(true, "auto");
  saveAIExecutionMode(false, "review");
  expect(readAIExecutionMode(false)).toBe("review");
  expect(readAIExecutionMode(true)).toBe("auto");
});

test("unexpected stored values never enable automatic mode", () => {
  window.localStorage.setItem("openshell.ai.execution-mode.global", "unknown");
  expect(readAIExecutionMode(false)).toBe("review");
});
