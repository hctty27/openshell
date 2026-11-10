import { afterEach, expect, test, vi } from "vitest";
import { readImeGeometry } from "./imeDiagnostics";

afterEach(() => {
  vi.restoreAllMocks();
  document.body.replaceChildren();
});

test("captures only element geometry and never text content", () => {
  const textarea = document.createElement("textarea");
  textarea.value = "secret user input";
  document.body.appendChild(textarea);
  vi.spyOn(textarea, "getBoundingClientRect").mockReturnValue({
    x: 12.4, y: 24.6, width: 320, height: 64,
    top: 24.6, left: 12.4, bottom: 88.6, right: 332.4,
    toJSON: () => ({}),
  });
  textarea.focus();

  const geometry = readImeGeometry();
  expect(geometry.target).toBe("textarea");
  expect(geometry.rectX).toBe(12.4);
  expect(geometry.rectY).toBe(24.6);
  expect(geometry.rectWidth).toBe(320);
  expect(JSON.stringify(geometry)).not.toContain("secret");
});

test("distinguishes xterm helper input from ordinary textarea", () => {
  const xterm = document.createElement("div");
  xterm.className = "xterm";
  const textarea = document.createElement("textarea");
  xterm.appendChild(textarea);
  document.body.appendChild(xterm);
  textarea.focus();
  expect(readImeGeometry().target).toBe("xterm");
});

test("reports a missing text target without collecting another element's text", () => {
  const button = document.createElement("button");
  button.textContent = "Do not include";
  document.body.appendChild(button);
  button.focus();
  const geometry = readImeGeometry();
  expect(geometry.target).toBe("other");
  expect(JSON.stringify(geometry)).not.toContain("Do not include");
});
