import { expect, test } from "vitest";
import { normalizeRemoteDirectory, parseOsc7Directory, parseOsc1337Directory } from "./terminalCwd";

test("parses reported Linux cwd including percent-encoded spaces and Unicode", () => {
  expect(parseOsc7Directory("file://server01/data/my%20logs")).toBe("/data/my logs");
  expect(parseOsc7Directory("file:///root/%E6%B5%8B%E8%AF%95")).toBe("/root/测试");
  expect(parseOsc1337Directory("CurrentDir=/data/my%20logs")).toBe("/data/my logs");
  expect(parseOsc1337Directory("CurrentDir=/root")).toBe("/root");
});
test("rejects non-directory, malformed or unsafe shell cwd reports", () => {
  expect(normalizeRemoteDirectory("relative/path")).toBeNull();
  expect(normalizeRemoteDirectory("/a\nb")).toBeNull();
  expect(parseOsc7Directory("https://server/root")).toBeNull();
  expect(parseOsc7Directory("file://server/%ZZ")).toBeNull();
  expect(parseOsc7Directory("file://server/root?bad=1")).toBeNull();
  expect(parseOsc1337Directory("RemoteHost=user@host")).toBeNull();
  expect(parseOsc1337Directory("CurrentDir=relative/path")).toBeNull();
});
