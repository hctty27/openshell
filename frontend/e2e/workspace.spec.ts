import { test, expect } from "@playwright/test";
test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    const listeners: Record<string, ((data: any) => void)[]> = {};
    let trusted = false;
    let generation = 0;
    const state: any = {
      sessions: [],
      groups: [],
      profiles: [],
      fontSize: "14",
      language:
        localStorage.getItem("fixture-language") ||
        new URLSearchParams(location.search).get("language") ||
        "zh-CN",
      theme: localStorage.getItem("fixture-theme") || "dark",
      activeProfile: "",
      version: "0.1.11",
    };
    const emit = (name: string, value: any) =>
      (listeners[name] ?? []).forEach((fn) => fn(value));
    (window as any).runtime = {
      EventsOn: (name: string, fn: (data: any) => void) => {
        (listeners[name] ??= []).push(fn);
        return () => {
          listeners[name] = listeners[name].filter((f) => f !== fn);
        };
      },
    };
    (window as any).__executions = [];
    (window as any).__resizes = [];
    (window as any).go = {
      main: {
        App: {
          State: async () => structuredClone(state),
          SaveSession: async (req: any) => {
            const s = {
              ...req.session,
              id: req.session.id || "session-" + (state.sessions.length + 1),
              credentialRef: req.saveSecret ? "vault-test" : "",
            };
            state.sessions = state.sessions
              .filter((v: any) => v.id !== s.id)
              .concat(s);
            return s;
          },
          SaveGroup: async (g: any) => g,
          SavePreference: async (key: string, value: string) => {
            state[key] = value;
            if (key === "theme") localStorage.setItem("fixture-theme", value);
            if (key === "language")
              localStorage.setItem("fixture-language", value);
          },
          SaveAPI: async (req: any) => {
            const p = { ...req.profile, id: "api-1" };
            state.profiles = [p];
            return p;
          },
          TestAPI: async () => {},
          Connect: async (tabId: string, sessionId: string) => {
            const ref = { tabId, sessionId, generation: ++generation };
            return trusted
              ? { ref, home: "/home/test" }
              : {
                  ref,
                  challenge: {
                    id: "trust",
                    address: "127.0.0.1:22",
                    fingerprint: "SHA256:TESTFIXTURE",
                    changed: false,
                  },
                };
          },
          TrustHost: async () => {
            trusted = true;
          },
          OpenTerminal: async (ref: any) => {
            (window as any).__terminalOutput = (text: string) =>
              emit("ssh:output", { ref, data: btoa(text) });
            if ((window as any).__rejectPTY) throw new Error("PTY 拒绝");
            setTimeout(
              () =>
                emit("ssh:output", {
                  ref,
                  sequence: 1,
                  data: btoa("Connected to test fixture\r\nroot@test:~$ "),
                }),
              60,
            );
          },
          WriteTerminal: async () => {},
          ResizeTerminal: async (ref: any, cols: number, rows: number) => {
            (window as any).__resizes.push({ cols, rows });
          },
          CloseTab: async () => {},
          Disconnect: async () => {},
          Chat: async (req: any) => {
            emit("ai:delta", { ref: req.ref, text: "正在检查服务器。" });
            return {
              text: "正在检查服务器。",
              proposal: {
                id: "proposal-1",
                ref: req.ref,
                command: "pwd",
                purpose: "检查当前目录",
                cwd: "/home/test",
                timeoutSeconds: 60,
                status: "awaiting_confirmation",
              },
            };
          },
          ConfirmCommand: async (_ref: any,id: string) => {
            (window as any).__executions.push(id);
            return {
              status: "completed",
              stdout: "/home/test\n",
              stderr: "",
              exitCode: 0,
              durationMillis: 12,
              truncated: false,
              reason: "",
            };
          },
          StartAutomatic: async (req: any, id: string) => {
            const snapshot = {
              id,
              ref: req.ref,
              status: "limit",
              steps: 1,
              roundSteps: 1,
              limit: 1,
              allowChanges: false,
              reason: "Round limit reached",
              reasonCode: "roundLimit",
            };
            (window as any).__auto = snapshot;
            emit("auto:event", {
              kind: "state",
              state: { ...snapshot, status: "running" },
            });
            emit("auto:event", {
              kind: "thinking",
              state: { ...snapshot, status: "running" },
              messageId: "auto-message",
            });
            emit("auto:event", {
              kind: "reply",
              state: snapshot,
              messageId: "auto-message",
              text: "已检查磁盘",
            });
            emit("auto:event", { kind: "state", state: snapshot });
            return snapshot;
          },
          ResumeAutomatic: async (
            _ref: any,id: string,
            approved: string,
            extend: boolean,
          ) => {
            (window as any).__resumed = { id, approved, extend };
            const snapshot = {
              ...(window as any).__auto,
              status: "completed",
              steps: 2,
              reason: "Task completed",
              reasonCode: "taskCompleted",
            };
            emit("auto:event", { kind: "state", state: snapshot });
            return snapshot;
          },
          StopAutomatic: async (_ref: any,id: string) => {
            emit("auto:event", {
              kind: "state",
              state: {
                ...(window as any).__auto,
                status: "stopped",
                reason: "Stopped",
                reasonCode: "taskStopped",
              },
            });
          },
          Continue: async () => ({ text: "当前目录是 /home/test。" }),
          PreviewContext: async () => ({
            text: "root@test:~$ pwd",
            truncated: false,
          }),
          CancelCommand: async () => {},
          ClearChat: async () => {},
        },
      },
    };
  });
});
test("session, custom API, terminal and explicitly confirmed AI command", async ({
  page,
}) => {
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "连接服务器，开始工作。" }),
  ).toBeVisible();
  await page.screenshot({ path: "../tmp/ui-empty.png" });
  await page.getByTitle("新建会话", { exact: true }).first().click();
  await page.getByLabel("会话名称", { exact: true }).fill("测试服务器");
  await page.getByLabel("主机地址").fill("127.0.0.1");
  await page.getByLabel("登录密码").fill("fixture-password");
  await page.getByText("保存到 Windows 凭据管理器").click();
  await page.getByRole("button", { name: "保存会话", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await page.getByText("测试服务器", { exact: true }).dblclick();
  await expect(page.getByText("确认服务器指纹", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "信任并连接" }).click();
  await expect(page.getByText("SSH 已连接", { exact: false })).toBeVisible();
  await page.getByTitle("设置", { exact: true }).click();
  await page.getByRole("button", { name: "AI 配置", exact: true }).click();
  await page.getByLabel("配置名称", { exact: true }).fill("测试 API");
  await page
    .getByLabel("Base URL", { exact: true })
    .fill("https://api.example.com/v1");
  await page.getByLabel("API Key", { exact: true }).fill("fixture-key");
  await page.getByLabel("模型名称", { exact: true }).fill("test-model");
  await page.getByRole("button", { name: "保存配置", exact: true }).click();
  await expect(page.getByText("配置已保存",{exact:true})).toBeVisible();
  await page.getByRole("button", { name: "关闭", exact: true }).last().click();
  await page.getByLabel("发送给 AI").fill("检查服务器目录");
  await page.getByTitle("发送消息").click();
  await expect(page.getByText("待确认的命令")).toBeVisible();
  for (const theme of ["light", "dark"]) {
    await page.getByTitle("设置", { exact: true }).click();
    await page
      .getByRole("button", { name: theme === "light" ? "浅色" : "深色", exact: true })
      .click();
    await page
      .getByRole("button", { name: "关闭", exact: true })
      .last()
      .click();
    const editor = page.getByRole("textbox", { name: "待执行命令" });
    for (const action of ["idle", "hover", "focus"]) {
      if (action === "hover") await editor.hover();
      if (action === "focus") await editor.focus();
      const contrast = await editor.evaluate((element) => {
        const style = getComputedStyle(element);
        const luminance = (color: string) => {
          const channels = color
            .match(/[\d.]+/g)!
            .slice(0, 3)
            .map(Number)
            .map((value) => {
              const v = value / 255;
              return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
            });
          return (
            channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722
          );
        };
        const foreground = luminance(style.color),
          background = luminance(style.backgroundColor);
        return (
          (Math.max(foreground, background) + 0.05) /
          (Math.min(foreground, background) + 0.05)
        );
      });
      expect(
        contrast,
        `${theme} command editor ${action}`,
      ).toBeGreaterThanOrEqual(4.5);
    }
    await page.screenshot({ path: `../tmp/command-${theme}.png` });
  }
  expect(await page.evaluate(() => (window as any).__executions.length)).toBe(
    0,
  );
  await page.getByRole("button", { name: "确认执行", exact: true }).click();
  await expect(page.getByText("执行完成", { exact: true })).toBeVisible();
  expect(await page.evaluate(() => (window as any).__executions)).toEqual([
    "proposal-1",
  ]);
  await expect(
    page.getByText("当前目录是 /home/test。", { exact: true }),
  ).toBeVisible();
  await page.screenshot({ path: "../tmp/ui-connected.png" });
  await page.getByLabel("AI 模式").selectOption("auto");
  await page.getByLabel("发送给 AI").fill("继续检查磁盘");
  await page.getByTitle("发送消息").click();
  await expect(page.getByRole("button", { name: "继续下一轮" })).toBeVisible();
  await expect(page.getByLabel("AI 模式")).toBeDisabled();
  await page.getByRole("button", { name: "继续下一轮" }).click();
  await expect(page.getByText("任务已完成", { exact: true })).toBeVisible();
  expect(await page.evaluate(() => (window as any).__resumed.extend)).toBe(
    true,
  );
  await page.getByLabel("发送给 AI").fill("再次检查");
  await page.getByTitle("发送消息").click();
  await page.getByTitle("停止任务").click();
  await expect(
    page.getByText("已停止，不再执行后续命令", { exact: true }),
  ).toBeVisible();

  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  await page.waitForTimeout(200);
  const resizeCount = await page.evaluate(
    () => (window as any).__resizes.length,
  );
  await page.getByTitle("设置", { exact: true }).click();
  await page.getByRole("button", { name: "终端", exact: true }).click();
  await page.getByRole("slider").focus();
  await page.getByRole("slider").press("ArrowRight");
  await expect
    .poll(() => page.evaluate(() => (window as any).__resizes.length))
    .toBeGreaterThan(resizeCount);
  await page.getByRole("button", { name: "关闭", exact: true }).last().click();
  await page.evaluate(() => {
    (window as any).__rejectPTY = true;
  });
  await page.getByTitle("重新连接", { exact: true }).click();
  await expect(
    page.getByRole("main").getByText("操作失败: PTY 拒绝", { exact: true }),
  ).toBeVisible();
  await page.getByTitle("收起 AI").click();
  await expect(page.getByText("AI 助手", { exact: true })).toHaveCount(0);
});

test("terminal stays within its viewport with stable scrollbar and both themes", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1200, height: 700 });
  await page.goto("/");
  await page.getByTitle("新建会话", { exact: true }).first().click();
  await page.getByLabel("会话名称", { exact: true }).fill("布局测试");
  await page.getByLabel("主机地址").fill("127.0.0.1");
  await page.getByLabel("登录密码").fill("fixture-password");
  await page.getByText("保存到 Windows 凭据管理器").click();
  await page.getByRole("button", { name: "保存会话", exact: true }).click();
  await page.getByText("布局测试", { exact: true }).dblclick();
  await page.getByRole("button", { name: "信任并连接" }).click();
  await expect(
    page.locator(".terminal-pane.active .xterm-screen"),
  ).toBeVisible();
  const geometry = () =>
    page.evaluate(() => {
      const pane = document.querySelector(".terminal-pane.active")!;
      const box = pane.getBoundingClientRect();
      const screen = pane
        .querySelector(".xterm-screen")!
        .getBoundingClientRect();
      const bar = pane.querySelector(".scrollbar.vertical")!;
      return {
        bottom: screen.bottom,
        right: screen.right,
        hostBottom: box.bottom,
        hostRight: box.right,
        width: screen.width,
        scrollbarWidth: bar.getBoundingClientRect().width,
        opacity: getComputedStyle(bar).opacity,
      };
    });
  await expect
    .poll(
      async () => (await geometry()).bottom <= (await geometry()).hostBottom,
    )
    .toBe(true);
  const before = await geometry();
  await page.evaluate(() =>
    (window as any).__terminalOutput("row\r\n".repeat(200) + "last-line> "),
  );
  await expect.poll(async () => (await geometry()).width).toBe(before.width);
  expect((await geometry()).scrollbarWidth).toBe(6);
  expect((await geometry()).opacity).toBe("1");
  await page.getByTitle("设置", { exact: true }).click();
  await page
    .getByRole("button", { name: "浅色", exact: true }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await expect(page.locator(".terminal-pane.active .xterm-viewport")).toHaveCSS(
    "background-color",
    "rgb(250, 251, 253)",
  );
  await page.getByRole("button", { name: "保存设置" }).click();
  await expect(page.getByText("设置已保存")).toBeVisible();
  await page.getByRole("button", { name: "关闭", exact: true }).last().click();
  await page.screenshot({ path: "../tmp/theme-light.png" });
  for (const size of [
    { width: 1000, height: 640 },
    { width: 1440, height: 900 },
  ]) {
    await page.setViewportSize(size);
    await expect
      .poll(async () => {
        const g = await geometry();
        return g.bottom <= g.hostBottom && g.right <= g.hostRight;
      })
      .toBe(true);
  }
  await page.getByTitle("收起 AI").click();
  await expect
    .poll(async () => {
      const g = await geometry();
      return g.bottom <= g.hostBottom && g.right <= g.hostRight;
    })
    .toBe(true);
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await page.getByTitle("设置", { exact: true }).click();
  await page
    .getByRole("button", { name: "深色", exact: true }).click();
  await page.screenshot({ path: "../tmp/theme-dark.png" });
});

test("compact sidebar removes detail actions and aligns single-row footer heights", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1200, height: 700 });
  await page.goto("/");
  await page.getByTitle("新建会话", { exact: true }).first().click();
  await page.getByLabel("会话名称", { exact: true }).fill("紧凑测试");
  await page.getByLabel("主机地址").fill("127.0.0.1");
  await page.getByLabel("登录密码").fill("fixture-password");
  await page.getByText("保存到 Windows 凭据管理器").click();
  await page.getByRole("button", { name: "保存会话", exact: true }).click();
  await page.getByRole("button", { name: "选中会话 紧凑测试" }).click();

  await expect(page.locator(".session-details .details-actions")).toHaveCount(
    0,
  );
  await expect(page.locator(".details-properties dd").first()).toHaveText(
    "紧凑测试",
  );
  await expect(
    page.locator(".tree-root > small, .group-heading small"),
  ).toHaveCount(0);
  await expect(page.getByTitle("管理 紧凑测试")).toHaveCount(0);
  await page
    .getByRole("button", { name: "选中会话 紧凑测试" })
    .click({ button: "right" });
  const contextMenu = page.getByRole("menu", { name: "会话操作" });
  await expect(
    contextMenu.getByRole("menuitem", { name: "编辑会话" }),
  ).toBeVisible();
  await expect(contextMenu).toHaveCSS("position", "fixed");
  expect(
    await contextMenu.evaluate(
      (element) => element.parentElement === document.body,
    ),
  ).toBe(true);
  const compactMenu = await contextMenu.evaluate((element) => {
    const menu = element.getBoundingClientRect();
    const firstItem = element
      .querySelector('[role="menuitem"]')!
      .getBoundingClientRect();
    const icon = element.querySelector("svg")!.getBoundingClientRect();
    return {
      width: menu.width,
      height: menu.height,
      rowHeight: firstItem.height,
      iconWidth: icon.width,
    };
  });
  expect(compactMenu.width).toBe(132);
  expect(compactMenu.height).toBeLessThanOrEqual(92);
  expect(compactMenu.rowHeight).toBe(25);
  expect(compactMenu.iconWidth).toBe(12);
  await page.keyboard.press("Escape");
  await expect(contextMenu).toHaveCount(0);

  await page.getByRole("button", { name: "选中会话 紧凑测试" }).dblclick();
  await page.getByRole("button", { name: "信任并连接" }).click();
  await expect(page.getByText("SSH 已连接", { exact: false })).toBeVisible();

  const geometry = await page.evaluate(() => {
    const box = (selector: string) =>
      document.querySelector(selector)!.getBoundingClientRect();
    return {
      header: box(".workspace-header").height,
      tabs: box(".tab-strip").height,
      server: box(".terminal-toolbar").height,
      detailsHeading: box(".details-heading").height,
      left: box(".sidebar-footer").height,
      right: box(".workspace-status").height,
      quick: box(".quick-command-bar").height,
      quickButton: box(".quick-command-manage").height,
      root: box(".tree-root").height,
      group: box(".group-heading").height,
      session: box(".session-row").height,
      detail: box(".details-properties > div").height,
      leftBottom: box(".sidebar-footer").bottom,
      rightBottom: box(".workspace-status").bottom,
      statusLeft: box(".workspace-version").x,
      statusRight: box(".workspace-connection").x,
      statusRightEdge: box(".workspace-connection").right,
      footerRightEdge: box(".workspace-status").right,
    };
  });
  expect(geometry.header).toBe(30);
  expect(geometry.tabs).toBe(30);
  expect(geometry.server).toBe(30);
  expect(geometry.detailsHeading).toBe(30);
  expect(geometry.left).toBe(30);
  expect(geometry.right).toBe(30);
  expect(geometry.quick).toBe(30);
  expect(geometry.quickButton).toBe(24);
  expect(geometry.root).toBe(26);
  expect(geometry.group).toBe(26);
  expect(geometry.session).toBe(26);
  expect(geometry.detail).toBe(21);
  expect(Math.abs(geometry.leftBottom - geometry.rightBottom)).toBeLessThan(1);
  expect(geometry.statusRight).toBeGreaterThan(geometry.statusLeft);
  expect(geometry.footerRightEdge - geometry.statusRightEdge).toBeLessThan(20);

  await page.getByTitle("设置", { exact: true }).click();
  await page.getByRole("button", { name: "终端", exact: true }).click();
  await page
    .getByRole("combobox", { name: "快速命令栏布局" })
    .selectOption("multi");
  await page.getByRole("button", { name: "保存设置" }).click();
  await expect(page.getByText("设置已保存")).toBeVisible();
  await page.getByRole("button", { name: "关闭", exact: true }).last().click();
  await expect(page.locator(".quick-command-bar.multi")).toBeVisible();
});

test("bilingual API placeholders translate without overwriting saved values", async ({ page }) => {
  await page.goto("/?language=en");
  await page.getByTitle("Settings", { exact: true }).click();
  await page.getByRole("button", { name: "AI Settings", exact: true }).click();
  const name = page.getByLabel("Profile name", { exact: true });
  const url = page.getByLabel("Base URL", { exact: true });
  await expect(name).toHaveValue("");
  await expect(name).toHaveAttribute("placeholder", "Custom API");
  await expect(url).toHaveValue("");
  await expect(url).toHaveAttribute("placeholder", "https://api.example.com/v1");

  await page.getByRole("button", { name: "Save profile" }).click();
  await expect(page.getByRole("alert")).toContainText("Enter a profile name");
  await name.fill("My saved API");
  await page.getByRole("button", { name: "Save profile" }).click();
  await expect(page.getByRole("alert")).toContainText("Enter an API base URL");
  await url.fill("https://api.example.com/v1");
  await page.getByLabel("Model name", { exact: true }).fill("my-model");
  await page.getByRole("button", { name: "Save profile" }).click();
  await expect(page.getByText("Profile saved")).toBeVisible();

  await page.getByRole("button", { name: "General", exact: true }).click();
  await page.locator("#settings-language").selectOption("zh-CN");
  await expect(page.locator("html")).toHaveAttribute("lang", "zh-CN");
  await page.getByRole("button", { name: "AI 配置", exact: true }).click();
  await expect(page.getByLabel("配置名称", { exact: true })).toHaveValue("My saved API");
  await expect(page.getByLabel("Base URL", { exact: true })).toHaveValue("https://api.example.com/v1");

  await page.getByTitle("新建 API 配置").click();
  await expect(page.getByLabel("配置名称", { exact: true })).toHaveValue("");
  await expect(page.getByLabel("配置名称", { exact: true })).toHaveAttribute("placeholder", "自定义 API");
  await expect(page.getByLabel("Base URL", { exact: true })).toHaveValue("");
  await page.getByRole("button", { name: "通用", exact: true }).click();
  await page.locator("#settings-language").selectOption("en");
  await expect(page.locator("html")).toHaveAttribute("lang", "en");
  await page.getByRole("button", { name: "AI Settings", exact: true }).click();
  await expect(page.getByLabel("Profile name", { exact: true })).toHaveValue("");
  await expect(page.getByLabel("Profile name", { exact: true })).toHaveAttribute("placeholder", "Custom API");
});

test("bilingual switching preserves terminal and draft and survives reload", async ({
  page,
}) => {
  await page.goto("/?language=en");
  await expect(
    page.getByRole("heading", { name: "Connect your server. Get to work." }),
  ).toBeVisible();
  await page.screenshot({ path: "../tmp/i18n-en-empty.png" });
  await page.getByTitle("New session", { exact: true }).first().click();
  await page.getByLabel("Session name", { exact: true }).fill("My Server 原名");
  await page.getByLabel("Host", { exact: true }).fill("127.0.0.1");
  await page.getByLabel("Password", { exact: true }).fill("fixture-password");
  await page.getByLabel("Save to Windows Credential Manager").check();
  await page.getByRole("button", { name: "Save session", exact: true }).click();
  await page.getByText("My Server 原名", { exact: true }).first().dblclick();
  await page.getByRole("button", { name: "Trust and connect" }).click();
  await expect(page.getByText("SSH connected", { exact: false })).toBeVisible();
  await expect(page.locator(".xterm")).toHaveCount(1);
  await page
    .locator(".xterm")
    .evaluate((el) => ((window as any).__originalTerminal = el));
  await page
    .getByLabel("Send to AI", { exact: true })
    .fill("Keep my draft 原文");
  await page.getByTitle("Settings", { exact: true }).click();
  await expect(page.locator("#settings-language")).toHaveValue("en");
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({
    path: "../tmp/i18n-en-settings.png",
    animations: "disabled",
  });
  await page.locator("#settings-language").selectOption("zh-CN");
  await expect(page.locator("html")).toHaveAttribute("lang", "zh-CN");
  await expect(
    page.getByRole("heading", { name: "设置", exact: true }),
  ).toBeVisible();
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({
    path: "../tmp/i18n-zh-settings.png",
    animations: "disabled",
  });
  await page.getByRole("button", { name: "关闭", exact: true }).last().click();
  await expect(page.getByLabel("发送给 AI", { exact: true })).toHaveValue(
    "Keep my draft 原文",
  );
  expect(
    await page
      .locator(".xterm")
      .evaluate((el) => el === (window as any).__originalTerminal),
  ).toBe(true);
  await expect(page.getByTitle("关闭 My Server 原名")).toHaveCount(1);
  await page.screenshot({ path: "../tmp/i18n-zh-terminal.png" });
  await page
    .getByText("My Server 原名", { exact: true })
    .first()
    .click({ button: "right" });
  await expect(page.getByRole("menuitem", { name: "编辑会话" })).toBeVisible();
  await page.screenshot({ path: "../tmp/i18n-zh-menu.png" });
  await page.keyboard.press("Escape");
  await page.reload();
  await page.getByTitle("设置", { exact: true }).click();
  await expect(page.locator("#settings-language")).toHaveValue("zh-CN");
  await page.locator("#settings-language").selectOption("en");
  await expect(
    page.getByRole("button", { name: "Save settings" }),
  ).toBeVisible();
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("lang", "en");
});

test("bilingual settings and session picker fit a compact window", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1000, height: 700 });
  await page.goto("/?language=en");
  await page.getByTitle("Settings", { exact: true }).click();
  for (const language of ["en", "zh-CN"]) {
    await page.locator("#settings-language").selectOption(language);
    for (const name of language === "en"
      ? ["General", "Terminal", "AI Settings", "Automatic"]
      : ["通用", "终端", "AI 配置", "自动执行"]) {
      await page.getByRole("button", { name, exact: true }).click();
      const dialog = page.locator(".settings-dialog");
      expect(
        await dialog.evaluate((el) => el.scrollWidth <= el.clientWidth + 1),
      ).toBe(true);
      expect(
        await dialog.evaluate((el) => {
          const box = el.getBoundingClientRect();
          return (
            box.left >= 0 &&
            box.right <= innerWidth &&
            box.top >= 0 &&
            box.bottom <= innerHeight
          );
        }),
      ).toBe(true);
      await page.screenshot({
        path: `../tmp/i18n-${language}-${name === "AI Settings" || name === "AI 配置" ? "api" : name === "Automatic" || name === "自动执行" ? "auto" : name === "Terminal" || name === "终端" ? "terminal" : "general"}-compact.png`,
      });
    }
    await page
      .getByRole("button", {
        name: language === "en" ? "General" : "通用",
        exact: true,
      })
      .click();
  }
  await page.getByRole("button", { name: "关闭", exact: true }).last().click();
  await page.getByTitle("打开会话列表").click();
  await expect(page.getByRole("dialog", { name: "会话管理" })).toBeVisible();
  await page.screenshot({ path: "../tmp/i18n-zh-picker-compact.png" });
});

test("AI header aligns with SSH title bar and compact model leaves space for Send", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1200, height: 800 });
  await page.goto("/");

  await page.getByTitle("设置", { exact: true }).click();
  await page.getByRole("button", { name: "AI 配置", exact: true }).click();
  await page.getByLabel("配置名称", { exact: true }).fill("测试 API");
  await page
    .getByLabel("Base URL", { exact: true })
    .fill("https://api.example.com/v1");
  await page
    .getByLabel("模型名称", { exact: true })
    .fill("grok-4.7(xhigh)-very-long-model-name");
  await page.getByRole("button", { name: "保存配置", exact: true }).click();
  await expect(page.getByText("配置已保存",{exact:true})).toBeVisible();
  await page.getByRole("button", { name: "关闭", exact: true }).last().click();
  await expect(page.getByLabel("当前模型")).toBeVisible();

  for (const width of [310, 370, 500]) {
    await page.locator(".app").evaluate((element, value) => {
      (element as HTMLElement).style.setProperty("--ai-width", `${value}px`);
    }, width);

    const positions = await page.evaluate(() => {
      const rect = (selector: string) =>
        document.querySelector(selector)!.getBoundingClientRect();
      const header = rect(".ai-header");
      const workspaceHeader = rect(".workspace-header");

      const mode = rect(".mode-select");
      const model = rect(".composer-model");
      const send = rect(".send-button");
      const tools = rect(".composer-tools");
      return {
        headerHeight: header.height,
        headerTop: header.top,
        mainTop: workspaceHeader.top,
        headerBottom: header.bottom,
        titleBottom: workspaceHeader.bottom,
        modelWidth: model.width,
        modeRight: mode.right,
        modelLeft: model.left,
        modelRight: model.right,
        sendLeft: send.left,
        sendRight: send.right,
        toolsRight: tools.right,
      };
    });

    expect(positions.headerHeight).toBe(30);
    expect(
      Math.abs(positions.headerTop - positions.mainTop),
    ).toBeLessThanOrEqual(1);
    expect(
      Math.abs(positions.headerBottom - positions.titleBottom),
    ).toBeLessThanOrEqual(1);
    expect(positions.modelWidth).toBeLessThanOrEqual(116);
    expect(positions.modelWidth).toBeGreaterThan(50);
    expect(positions.modelLeft).toBeGreaterThan(positions.modeRight);
    expect(positions.sendLeft - positions.modelRight).toBeGreaterThanOrEqual(4);
    expect(positions.sendRight).toBeLessThanOrEqual(positions.toolsRight);
  }

  await expect(page.getByLabel("当前模型")).toHaveAttribute(
    "title",
    /grok-4\.7\(xhigh\)-very-long-model-name/,
  );
});
