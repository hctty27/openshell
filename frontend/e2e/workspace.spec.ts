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
    (window as any).__quitConfirmed = 0;
    (window as any).__closeGuardReady = false;
    (window as any).__requestQuit = () => emit("app:quit-requested", null);
    (window as any).go = {
      main: {
        App: {
          State: async () => structuredClone(state),
          SetCloseGuardReady: async (ready: boolean) => {
            (window as any).__closeGuardReady = ready;
          },
          QuitConfirmed: async () => {
            (window as any).__quitConfirmed++;
          },
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
test.afterEach(async ({ page }, info) => {
  if (info.status === info.expectedStatus || page.isClosed()) return;
  const detail = await page.evaluate(() => ({
    browserFixture: !!(window as any).go?.main?.App,
    dialogs: [...document.querySelectorAll("dialog")].map(el => ({ open: el.open, text: el.textContent?.trim().slice(0, 500) })),
    tabs: [...document.querySelectorAll(".terminal-tab")].map(el => el.textContent?.trim()),
    alerts: [...document.querySelectorAll('[role="alert"]')].map(el => el.textContent?.trim()),
    content: document.body.innerText.slice(0, 800),
  })).catch(error => ({ error: String(error) }));
  console.log("E2E_MIGRATION_DIAGNOSTICS", JSON.stringify(detail));
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
  await expect(page.locator(".terminal-tab.active .connection-state-connected")).toHaveAttribute("aria-label", "SSH 已连接");
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

async function pointerDrag(page: import("@playwright/test").Page,
  source: import("@playwright/test").Locator, x: number, y: number) {
  const bounds = await source.boundingBox();
  expect(bounds).not.toBeNull();
  await page.mouse.move(bounds!.x + bounds!.width / 2, bounds!.y + bounds!.height / 2);
  await page.mouse.down();
  await page.mouse.move(x, y, { steps: 15 });
  await page.mouse.up();
}

test("dragging a connected tab splits a terminal without reconnecting", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto("/");
  for (const [name, host] of [["server-a", "127.0.0.1"], ["server-b", "127.0.0.2"]]) {
    await page.getByTitle("新建会话", { exact: true }).first().click();
    await page.getByLabel("会话名称", { exact: true }).fill(name);
    await page.getByLabel("主机地址").fill(host);
    await page.getByLabel("登录密码").fill("fixture-password");
    await page.getByText("保存到 Windows 凭据管理器").click();
    await page.getByRole("button", { name: "保存会话", exact: true }).click();
    await page.getByText(name, { exact: true }).dblclick();
    if (name === "server-a") await page.getByRole("button", { name: "信任并连接" }).click();
  }
  await expect(page.locator(".terminal-tab .connection-state-connected")).toHaveCount(2);
  await expect(page.locator(".terminal-split-select")).toHaveCount(0);
  const secondTab = page.locator(".terminal-tab").nth(1);
  const secondBounds = await secondTab.boundingBox();
  expect(secondBounds).not.toBeNull();
  await pointerDrag(page, page.locator(".terminal-tab button:first-child").first(),
    secondBounds!.x + secondBounds!.width - 8, secondBounds!.y + secondBounds!.height / 2);
  await expect(page.locator(".terminal-tab button:first-child"))
    .toHaveText(["server-b", "server-a"]);
  const destination = page.locator(".terminal-pane.visible");
  const bounds = await destination.boundingBox();
  expect(bounds).not.toBeNull();
  await destination.evaluate(el => {
    (window as any).__originalSplitTerminal = el.querySelector(".xterm");
  });
  await pointerDrag(page, page.locator(".terminal-tab button:first-child").last(),
    bounds!.x + bounds!.width - 25, bounds!.y + bounds!.height / 2);
  await expect(page.locator(".terminal-container")).toHaveClass(/terminal-split-columns/);
  await expect(page.locator(".terminal-pane.visible")).toHaveCount(2);
  await expect(page.getByRole("separator", { name: "调整终端分屏比例" })).toBeVisible();
  expect(await page.locator(".terminal-pane.active .xterm").evaluate(el =>
    el === (window as any).__originalSplitTerminal)).toBe(true);
  await page.getByRole("button", { name: "关闭分屏" }).click();
  await expect(page.locator(".terminal-container")).not.toHaveClass(/terminal-split/);
  await expect(page.locator(".terminal-pane.visible")).toHaveCount(1);
  await expect(page.locator(".terminal-tab .connection-state-connected")).toHaveCount(2);
});

test("four sessions support nested splits, independent handles and undocking", async ({ page }) => {
  await page.setViewportSize({ width: 1500, height: 900 });
  await page.goto("/");
  for (const name of ["pane-a", "pane-b", "pane-c", "pane-d"]) {
    await page.getByTitle("新建会话", { exact: true }).first().click();
    await page.getByLabel("会话名称", { exact: true }).fill(name);
    await page.getByLabel("主机地址").fill("127.0.0.1");
    await page.getByLabel("登录密码").fill("fixture-password");
    await page.getByText("保存到 Windows 凭据管理器").click();
    await page.getByRole("button", { name: "保存会话", exact: true }).click();
    await page.getByText(name, { exact: true }).dblclick();
    if (name === "pane-a") await page.getByRole("button", { name: "信任并连接" }).click();
  }
  await expect(page.locator(".terminal-tab .connection-state-connected")).toHaveCount(4);
  const drag = async (source: string, zone: "right" | "bottom") => {
    const tab = page.locator(".terminal-tab").filter({ hasText: source });
    const target = page.locator(".terminal-pane.active");
    const box = await target.boundingBox();
    expect(box).not.toBeNull();
    await pointerDrag(page, tab.locator("button:first-child"), zone === "right"
      ? box!.x + box!.width - 15 : box!.x + box!.width / 2,
      zone === "bottom" ? box!.y + box!.height - 15 : box!.y + box!.height / 2);
  };
  await drag("pane-a", "right");
  await drag("pane-b", "bottom");
  await drag("pane-c", "right");
  await expect(page.locator(".terminal-pane.visible")).toHaveCount(4);
  await expect(page.getByRole("separator", { name: "调整终端分屏比例" })).toHaveCount(3);
  for (const pane of await page.locator(".terminal-pane.visible").all()) {
    expect((await pane.boundingBox())!.width).toBeGreaterThan(0);
    expect((await pane.boundingBox())!.height).toBeGreaterThan(0);
  }
  const stripBounds = await page.locator(".tab-strip").boundingBox();
  expect(stripBounds).not.toBeNull();
  await pointerDrag(page, page.locator(".terminal-tab").filter({ hasText: "pane-a" }).locator("button:first-child"),
    stripBounds!.x + stripBounds!.width - 15, stripBounds!.y + 15);
  await expect(page.locator(".terminal-pane.visible")).toHaveCount(3);
  await expect(page.getByRole("separator", { name: "调整终端分屏比例" })).toHaveCount(2);
  await expect(page.locator(".terminal-tab .connection-state-connected")).toHaveCount(4);
  await page.locator(".terminal-pane.active .terminal-pane-undock").click();
  await expect(page.locator(".terminal-pane.visible")).toHaveCount(2);
  await expect(page.getByRole("separator", { name: "调整终端分屏比例" })).toHaveCount(1);
  await expect(page.locator(".terminal-tab .connection-state-connected")).toHaveCount(4);
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
    "rgb(255, 255, 255)",
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

test("terminal backdrop fills its pane across mixed application and terminal palettes", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1200, height: 720 });
  await page.goto("/");
  await page.getByTitle("新建会话", { exact: true }).first().click();
  await page.getByLabel("会话名称", { exact: true }).fill("无露边测试");
  await page.getByLabel("主机地址").fill("127.0.0.1");
  await page.getByLabel("登录密码").fill("fixture-password");
  await page.getByText("保存到 Windows 凭据管理器").click();
  await page.getByRole("button", { name: "保存会话", exact: true }).click();
  await page.getByText("无露边测试", { exact: true }).dblclick();
  await page.getByRole("button", { name: "信任并连接" }).click();
  await expect(page.locator(".terminal-pane.active .xterm-screen")).toBeVisible();

  await page.getByTitle("设置", { exact: true }).click();
  await page.getByRole("button", { name: "浅色", exact: true }).click();
  await page.getByRole("button", { name: "终端", exact: true }).click();
  await page.locator("#settings-terminal-theme").selectOption("classic");
  await page.getByRole("button", { name: "保存设置" }).click();
  await page.getByRole("button", { name: "关闭", exact: true }).last().click();

  const snapshot = () => page.evaluate(() => {
    const container = document.querySelector(".terminal-container")!;
    const pane = container.querySelector(".terminal-pane.active")!;
    const xterm = pane.querySelector(".xterm")!;
    const viewport = pane.querySelector(".xterm-viewport")!;
    const screen = pane.querySelector(".xterm-screen")!;
    const scrollbar = pane.querySelector(".xterm-scrollbar.xterm-vertical")!;
    const outer = container.getBoundingClientRect();
    const inner = pane.getBoundingClientRect();
    const glyphs = screen.getBoundingClientRect();
    const scroll = scrollbar.getBoundingClientRect();
    return {
      backgrounds: [container, pane, xterm, viewport].map((el) =>
        getComputedStyle(el).backgroundColor
      ),
      leftGap: inner.left - outer.left,
      topGap: inner.top - outer.top,
      rightGap: outer.right - inner.right,
      bottomGap: outer.bottom - inner.bottom,
      textInsetLeft: glyphs.left - inner.left,
      textInsetTop: glyphs.top - inner.top,
      scrollbarRightInset: inner.right - scroll.right,
      screenRight: glyphs.right,
      paneRight: inner.right,
    };
  });

  await expect.poll(async () => (await snapshot()).backgrounds)
    .toEqual(Array(4).fill("rgb(15, 17, 21)"));
  const dark = await snapshot();
  for (const gap of [dark.leftGap, dark.topGap, dark.rightGap, dark.bottomGap]) {
    expect(Math.abs(gap)).toBeLessThan(1);
  }
  expect(dark.textInsetLeft).toBeGreaterThanOrEqual(10);
  expect(dark.textInsetTop).toBeGreaterThanOrEqual(8);
  expect(dark.scrollbarRightInset).toBeGreaterThanOrEqual(0);
  expect(dark.scrollbarRightInset).toBeLessThanOrEqual(10);
  expect(dark.screenRight).toBeLessThanOrEqual(dark.paneRight + 1);

  await page.getByTitle("设置", { exact: true }).click();
  await page.getByRole("button", { name: "终端", exact: true }).click();
  await page.locator("#settings-terminal-theme").selectOption("light");
  await page.getByRole("button", { name: "保存设置" }).click();
  await page.getByRole("button", { name: "关闭", exact: true }).last().click();
  await expect.poll(async () => (await snapshot()).backgrounds)
    .toEqual(Array(4).fill("rgb(248, 250, 252)"));

  await page.getByTitle("设置", { exact: true }).click();
  await page.getByRole("button", { name: "深色", exact: true }).click();
  await page.getByRole("button", { name: "关闭", exact: true }).last().click();
  await expect.poll(async () => (await snapshot()).backgrounds)
    .toEqual(Array(4).fill("rgb(248, 250, 252)"));
});

test("compact workspace removes redundant chrome while keeping quick commands", async ({
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
  await expect(
    contextMenu.getByRole("menuitem", { name: "复制会话" }),
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
  expect(compactMenu.height).toBeLessThanOrEqual(118);
  expect(compactMenu.rowHeight).toBe(25);
  expect(compactMenu.iconWidth).toBe(12);
  await page.keyboard.press("Escape");
  await expect(contextMenu).toHaveCount(0);

  await page.getByRole("button", { name: "选中会话 紧凑测试" }).dblclick();
  await page.getByRole("button", { name: "信任并连接" }).click();
  await expect(page.locator(".terminal-tab.active .connection-state-connected")).toHaveAttribute("aria-label", "SSH 已连接");

  await expect(page.locator(".brand, .sidebar-footer, .workspace-status")).toHaveCount(0);
  const settingsButton = page.getByTitle("设置", { exact: true });
  await expect(settingsButton).toBeVisible();
  await expect(settingsButton.locator("xpath=../..")).toHaveClass(/window-titlebar/);

  const geometry = await page.evaluate(() => {
    const height = (selector: string) =>
      document.querySelector(selector)!.getBoundingClientRect().height;
    return {
      header: height(".window-titlebar"),
      tabs: height(".tab-strip"),
      server: height(".terminal-toolbar"),
      detailsHeading: height(".details-heading"),
      quick: height(".quick-command-bar"),
      quickButton: height(".quick-command-manage"),
      root: height(".tree-root"),
      group: height(".group-heading"),
      session: height(".session-row"),
      detail: height(".details-properties > div"),
    };
  });
  expect(geometry.header).toBe(32);
  expect(geometry.tabs).toBe(30);
  expect(geometry.server).toBe(30);
  expect(geometry.detailsHeading).toBe(30);
  expect(geometry.quick).toBe(30);
  expect(geometry.quickButton).toBe(24);
  expect(geometry.root).toBe(26);
  expect(geometry.group).toBe(26);
  expect(geometry.session).toBe(26);
  expect(geometry.detail).toBe(21);

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

test("bilingual switching preserves SSH terminal and survives reload", async ({
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
  await expect(page.locator(".terminal-tab.active .connection-state-connected")).toHaveAttribute("aria-label", "SSH connected");
  await expect(page.locator(".xterm")).toHaveCount(1);
  await page
    .locator(".xterm")
    .evaluate((el) => ((window as any).__originalTerminal = el));
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
      ? ["General", "Terminal", "Connection"]
      : ["通用", "终端", "连接"]) {
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
        path: `../tmp/i18n-${language}-${name === "Connection" || name === "连接" ? "connection" : name === "Terminal" || name === "终端" ? "terminal" : "general"}-compact.png`,
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


test("AI header aligns with SSH title bar", async ({ page }) => {
  await page.setViewportSize({ width: 1200, height: 700 });
  await page.goto("/");
  await page.getByTitle("新建会话", { exact: true }).first().click();
  await page.getByLabel("会话名称", { exact: true }).fill("对齐测试");
  await page.getByLabel("主机地址").fill("127.0.0.1");
  await page.getByLabel("登录密码").fill("fixture-password");
  await page.getByText("保存到 Windows 凭据管理器").click();
  await page.getByRole("button", { name: "保存会话", exact: true }).click();
  await page.getByRole("button", { name: "选中会话 对齐测试" }).dblclick();
  await page.getByRole("button", { name: "信任并连接" }).click();
  await expect(page.locator(".terminal-toolbar")).toBeVisible();

  await page.locator(".ai-rail").click();
  await page.getByRole("button", { name: "固定 AI 栏" }).click();
  await expect(page.locator(".ai-panel")).toBeVisible();
  const alignment = await page.evaluate(() => {
    const rect = (selector: string) => document.querySelector(selector)!.getBoundingClientRect();
    const tabs = rect(".tab-strip");
    const connection = rect(".terminal-toolbar");
    const aiHeader = rect(".ai-header");
    const aiControls = rect(".ai-controls");
    return {
      tabHeight: tabs.height, headerHeight: aiHeader.height,
      connectionHeight: connection.height, controlsHeight: aiControls.height,
      headerOffset: aiHeader.top - tabs.top,
      controlsOffset: aiControls.top - connection.top,
      horizontalOverflow: document.querySelector(".ai-panel")!.scrollWidth
        > document.querySelector(".ai-panel")!.clientWidth + 1,
    };
  });
  expect(alignment.tabHeight).toBe(30);
  expect(alignment.headerHeight).toBe(30);
  expect(alignment.connectionHeight).toBe(30);
  expect(alignment.controlsHeight).toBe(30);
  expect(Math.abs(alignment.headerOffset)).toBeLessThanOrEqual(1);
  expect(Math.abs(alignment.controlsOffset)).toBeLessThanOrEqual(1);
  expect(alignment.horizontalOverflow).toBe(false);
  await expect(page.getByRole("button", { name: "收起 AI 栏" })).toHaveCount(0);

  await page.getByTitle("新建会话", { exact: true }).first().click();
  await page.getByLabel("会话名称", { exact: true }).fill("第二台非常长名称的服务器");
  await page.getByLabel("主机地址").fill("127.0.0.2");
  await page.getByLabel("登录密码").fill("fixture-password");
  await page.getByText("保存到 Windows 凭据管理器").click();
  await page.getByRole("button", { name: "保存会话", exact: true }).click();
  await page.getByRole("button", { name: "选中会话 第二台非常长名称的服务器" }).dblclick();
  await page.getByRole("button", { name: "信任并连接" }).click();

  const geometry = async () => page.locator(".ai-controls").evaluate(element => {
    const selector = element.querySelector(".ai-selector-button")!.getBoundingClientRect();
    const review = element.querySelector("select")!.getBoundingClientRect();
    return { selectorX: selector.x, selectorWidth: selector.width, reviewX: review.x, reviewWidth: review.width };
  });
  const before = await geometry();
  await page.locator(".ai-selector-button").click();
  await page.locator(".ai-target-menu input[type=checkbox]").first().check();
  const after = await geometry();
  expect(after.selectorX).toBe(before.selectorX);
  expect(after.selectorWidth).toBe(before.selectorWidth);
  expect(after.reviewX).toBe(before.reviewX);
  expect(after.reviewWidth).toBe(before.reviewWidth);
  await expect(page.locator(".ai-selector-label")).toContainText("+1");
  await expect(page.locator(".ai-target-menu")).toBeVisible();
});
