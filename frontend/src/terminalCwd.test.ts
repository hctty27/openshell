import { expect, test } from "vitest";
import { normalizeRemoteDirectory, parseOsc7Directory, parseOsc1337Directory, parseOscTitleDirectory } from "./terminalCwd";

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
test("Xshell-compatible OSC title paths resolve absolute cwd and tilde home", () => {
  expect(parseOscTitleDirectory("root@server:/data/hc", "/root")).toBe("/data/hc");
  expect(parseOscTitleDirectory("user@host: /data/my logs", "/home/user")).toBe("/data/my logs");
  expect(parseOscTitleDirectory("root@server:~", "/root")).toBe("/root");
  expect(parseOscTitleDirectory("root@server:~/logs", "/root")).toBe("/root/logs");
  expect(parseOscTitleDirectory("root@server:~", "/")).toBe("/");
  expect(parseOscTitleDirectory("root@server:~/etc", "/")).toBe("/etc");
  expect(parseOscTitleDirectory("root@server:~/logs")).toBeNull();
  expect(parseOscTitleDirectory("OpenShell - connected")).toBeNull();
  expect(parseOscTitleDirectory("root@server:relative/path", "/root")).toBeNull();
  expect(parseOscTitleDirectory("root@server:/a\nb", "/root")).toBeNull();
});
