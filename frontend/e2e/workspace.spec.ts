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
      theme: localStorage.getItem("fixture-theme") || "dark",
      activeProfile: "",
      version: "0.1.6",
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
          ConfirmCommand: async (id: string) => {
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
  await page.getByRole("button", { name: "AI API", exact: true }).click();
  await page
    .getByLabel("Base URL", { exact: true })
    .fill("https://api.example.com/v1");
  await page.getByLabel("API Key", { exact: true }).fill("fixture-key");
  await page.getByLabel("模型名称", { exact: true }).fill("test-model");
  await page.getByRole("button", { name: "保存配置", exact: true }).click();
  await expect(page.getByText("配置已保存")).toBeVisible();
  await page.getByRole("button", { name: "关闭", exact: true }).last().click();
  await page.getByLabel("发送给 AI").fill("检查服务器目录");
  await page.getByTitle("发送消息").click();
  await expect(page.getByText("待确认的命令")).toBeVisible();
  for (const theme of ["light", "dark"]) {
    await page.getByTitle("设置", { exact: true }).click();
    await page
      .getByRole("combobox", { name: "主题", exact: true })
      .selectOption(theme);
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
    page.getByRole("main").getByText("PTY 拒绝", { exact: true }),
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
    .getByRole("combobox", { name: "主题", exact: true })
    .selectOption("light");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await expect(page.locator(".terminal-pane.active .xterm-viewport")).toHaveCSS(
    "background-color",
    "rgb(250, 251, 253)",
  );
  await page.getByRole("button", { name: "保存外观" }).click();
  await expect(page.getByText("外观已保存")).toBeVisible();
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
    .getByRole("combobox", { name: "主题", exact: true })
    .selectOption("dark");
  await page.screenshot({ path: "../tmp/theme-dark.png" });
});
