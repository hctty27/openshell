import { expect, test } from "vitest";
import { BASH_CWD_REPORT_COMMAND, buildRemoteCdCommand, decideCloneDirectoryAction, normalizeRemoteDirectory, parseOsc7Directory, parseOsc1337Directory, parseOscTitleDirectory } from "./terminalCwd";

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

test("Bash OSC 7 reporting escapes URL delimiters in directory names", () => {
  expect(parseOsc7Directory("file://server01/data/100%25%3F%23notes"))
    .toBe("/data/100%?#notes");
  expect(BASH_CWD_REPORT_COMMAND).toContain("${PWD//%/%25}");
  expect(BASH_CWD_REPORT_COMMAND).toContain("${path//#/%23}");
  expect(BASH_CWD_REPORT_COMMAND).toContain("${path//\\?/%3F}");
});

test("cloned SSH directories are shell-quoted and invalid paths are ignored", () => {
  expect(buildRemoteCdCommand("/data/my logs")).toBe("cd -- '/data/my logs'\r");
  expect(buildRemoteCdCommand("/data/a'b")).toBe("cd -- '/data/a'\\''b'\r");
  expect(buildRemoteCdCommand("/data/$(whoami);`id`")).toBe("cd -- '/data/$(whoami);`id`'\r");
  expect(buildRemoteCdCommand("relative/path")).toBeNull();
  expect(buildRemoteCdCommand("/data/bad\npath")).toBeNull();
});

test("cloned SSH directory restoration waits for a shell and skips JumpServer menus", () => {
  expect(decideCloneDirectoryAction("/data", "/root", "何程，欢迎使用JumpServer开源堡垒机系统")).toBe("wait");
  expect(decideCloneDirectoryAction("/data", "/root", "Opt>")).toBe("skip");
  expect(decideCloneDirectoryAction("/data", "/root", "Opt>  ")).toBe("skip");
  expect(decideCloneDirectoryAction("/data", "/root", "No assets found")).toBe("wait");
  expect(decideCloneDirectoryAction("/data", "/root", "bash-5.2$")).toBe("wait");
  expect(decideCloneDirectoryAction("/data", "/root", "vim -- INSERT --")).toBe("wait");
});

test("cloned SSH directory restoration avoids redundant cd commands", () => {
  expect(decideCloneDirectoryAction("/root", "/root", "root@us-server:~#")).toBe("skip");
  expect(decideCloneDirectoryAction("/root/", "/root", "root@us-server:/root#")).toBe("skip");
  expect(decideCloneDirectoryAction("/root", "/root", "[root@VM-64-6-centos ~]#")).toBe("skip");
  expect(decideCloneDirectoryAction("/data/logs", "/root", "[root@server /data/logs]#")).toBe("skip");
  expect(decideCloneDirectoryAction("/data/logs", "/root", "root@server:~#", "/data/logs")).toBe("skip");
});

test("cloned SSH directory restoration still changes directories when needed", () => {
  expect(decideCloneDirectoryAction("/data/project", "/root", "root@us-server:~#")).toBe("send");
  expect(decideCloneDirectoryAction("/data/project", "/root", "[root@host ~]#")).toBe("send");
  expect(decideCloneDirectoryAction("/data/project", "/root", "root@host:/tmp#", "/tmp")).toBe("send");
  expect(decideCloneDirectoryAction("relative/path", "/root", "root@host:~#")).toBe("skip");
});
