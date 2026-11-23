import { beforeAll, expect, test } from "vitest";
import { initializeI18n } from "../i18n";
import { splitHostPort } from "./SettingsDialog";
import { sortByName } from "./SessionTree";
import { transferErrorText } from "./TransferCenter";

beforeAll(() => initializeI18n("zh-CN"));

test("splitHostPort extracts a typed port and leaves plain hosts alone", () => {
  expect(splitHostPort("example.com:2222")).toEqual({ host: "example.com", port: 2222 });
  expect(splitHostPort(" 10.0.0.1:22 ")).toEqual({ host: "10.0.0.1", port: 22 });
  expect(splitHostPort("[2001:db8::1]:2200")).toEqual({ host: "2001:db8::1", port: 2200 });
  expect(splitHostPort("example.com")).toBeNull();
  expect(splitHostPort("2001:db8::1")).toBeNull();
  expect(splitHostPort("example.com:0")).toBeNull();
  expect(splitHostPort("example.com:70000")).toBeNull();
});

test("sortByName orders sessions naturally and stably", () => {
  const sorted = sortByName([
    { id: "c", name: "web10" },
    { id: "b", name: "Web2" },
    { id: "a", name: "db" },
    { id: "d", name: "web2" },
  ]);
  expect(sorted.map((item) => item.id)).toEqual(["a", "b", "d", "c"]);
});

test("transferErrorText localizes coded errors and keeps plain text", () => {
  const coded = `OPENSHELL_ERROR:${JSON.stringify({ code: "zmodemRemoteDeclined", params: { count: 1 } })}`;
  const text = transferErrorText(coded);
  expect(text).not.toContain("OPENSHELL_ERROR");
  expect(text.length).toBeGreaterThan(0);
  expect(transferErrorText("disk full")).toBe("disk full");
  expect(transferErrorText(undefined)).toBe("");
});
