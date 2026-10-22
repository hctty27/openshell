import { test, expect } from "@playwright/test";
test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    const listeners: Record<string, ((v: any) => void)[]> = {};
    const saved = JSON.parse(localStorage.getItem("memory-fixture") || "null");
    let counter = saved?.counter ?? 1;
    let last = saved?.last ?? "c1";
    let generation = 0;
    let selectionRevision = 0;
    const make = (id: string) => ({
      id,
      serverKey: "server",
      sessionId: "s",
      title: "",
      titleManual: false,
      summary: "",
      summaryThroughSeq: 0,
      revision: 0,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    const conversations: any = saved?.conversations ?? {
      c1: { ...make("c1"), title: "Redis", revision: 1 },
    };
    const messages: any = saved?.messages ?? {
      c1: [
        {
          id: "saved",
          conversationId: "c1",
          seq: 1,
          role: "user",
          content: "历史记录已恢复",
          status: "completed",
          createdAt: "",
        },
      ],
    };
    const selected: Record<string, string> = {};
    const runs: any = {};
    const seq: any = {};
    const persist = () =>
      localStorage.setItem(
        "memory-fixture",
        JSON.stringify({ counter, last, conversations, messages }),
      );
    const emit = (id: string, kind: string, message?: any) => {
      const c = conversations[id];
      const e = {
        selectionRevision: ++selectionRevision,
        eventId: crypto.randomUUID(),
        eventSeq: (seq[id] = (seq[id] ?? 0) + 1),
        conversationId: id,
        serverKey: "server",
        kind,
        conversation: { ...c },
        revision: c.revision,
        run: runs[id] ?? null,
        message,
        selectedByTab: { ...selected },
      };
      (listeners["conversation:event"] ?? []).forEach((f) => f(e));
      persist();
    };
    const read = (id: string, before = 0) => ({
      conversation: { ...conversations[id] },
      messages: structuredClone(
        (messages[id] ?? [])
          .filter((m: any) => !before || m.seq < before)
          .slice(-100),
      ),
      beforeSeq: 1,
      hasMore: false,
      run: runs[id] ?? null,
      eventSeq: seq[id] ?? 0,
    });
    const append = (
      id: string,
      role: string,
      content: string,
      messageID = crypto.randomUUID(),
    ) => {
      const m = {
        id: messageID,
        conversationId: id,
        seq: (messages[id] ?? []).length + 1,
        role,
        content,
        status: "completed",
        createdAt: "",
      };
      (messages[id] ??= []).push(m);
      conversations[id].revision++;
      conversations[id].updatedAt = new Date().toISOString();
      emit(id, "message", m);
    };
    (window as any).runtime = {
      EventsOn: (name: string, fn: (v: any) => void) => {
        (listeners[name] ??= []).push(fn);
        return () => {
          listeners[name] = listeners[name].filter((f) => f !== fn);
        };
      },
    };
    (window as any).go = {
      main: {
        App: {
          State: async () => ({
            language:
              new URLSearchParams(location.search).get("language") || "zh-CN",
            theme: new URLSearchParams(location.search).get("theme") || "dark",
            sessions: [
              {
                id: "s",
                name: "server",
                host: "example.com",
                port: 22,
                username: "root",
                authType: "key",
                privateKeyPath: "",
                credentialRef: "saved",
                groupId: "",
              },
            ],
            groups: [],
            profiles: [
              {
                id: "api",
                name: "Test model",
                model: "test",
                toolsEnabled: false,
                baseUrl: "https://example.com",
                secretRef: "",
              },
            ],
            activeProfile: "api",
            fontSize: "14",
            version: "0.1.26",
            saveChatHistory: true,
            autoSummarize: true,
          }),
          Connect: async (tabId: string, sessionId: string) => {
            const ref = { tabId, sessionId, generation: ++generation };
            selected[tabId] = last;
            emit(last, "selection");
            return { ref, home: "/root", conversationId: last };
          },
          OpenTerminal: async () => {},
          ResizeTerminal: async () => {},
          WriteTerminal: async () => {},
          CloseTab: async (tab: string) => {
            delete selected[tab];
          },
          SavePreference: async () => {},
          ListConversations: async () => ({
            items: Object.values(conversations),
            nextCursor: null,
          }),
          ReadConversation: async (_ref: any, id: string, before: number) =>
            read(id, before),
          CreateConversation: async (ref: any) => {
            const id = "c" + ++counter;
            conversations[id] = make(id);
            messages[id] = [];
            selected[ref.tabId] = last = id;
            emit(id, "created");
            return conversations[id];
          },
          SelectConversation: async (ref: any, id: string) => {
            selected[ref.tabId] = last = id;
            emit(id, "selection");
            return read(id);
          },
          RenameConversation: async (_ref: any, id: string, title: string) => {
            conversations[id].title = title;
            conversations[id].titleManual = true;
            conversations[id].revision++;
            emit(id, "renamed");
            return conversations[id];
          },
          ClearChat: async (tab: string) => {
            const id = selected[tab];
            messages[id] = [];
            conversations[id].revision++;
            emit(id, "cleared");
          },
          DeleteConversation: async (_ref: any, id: string) => {
            let fallback = Object.keys(conversations).find((c) => c !== id);
            if (!fallback) {
              fallback = "c" + ++counter;
              conversations[fallback] = make(fallback);
              messages[fallback] = [];
            }
            for (const tab of Object.keys(selected))
              if (selected[tab] === id) selected[tab] = fallback;
            last = fallback;
            emit(id, "deleted");
            delete conversations[id];
            delete messages[id];
            persist();
            emit(fallback, "selection");
          },
          Chat: async (req: any) => {
            const id = selected[req.ref.tabId];
            runs[id] = {
              id: "run",
              conversationId: id,
              ownerRef: req.ref,
              kind: "chat",
              status: "running",
            };
            append(id, "user", req.text, req.requestId);
            const messageID = crypto.randomUUID();
            emit(id, "stream", {
              id: messageID,
              conversationId: id,
              seq: 0,
              role: "assistant",
              content: "共享的流式回复",
              status: "streaming",
              createdAt: "",
            });
            return new Promise((resolve) => {
              (window as any).__finishMemoryReply = () => {
                append(id, "assistant", "共享回复已完成", messageID);
                delete runs[id];
                emit(id, "run");
                resolve({ text: "共享回复已完成" });
              };
            });
          },
          CancelChat: async () => {
            (window as any).__finishMemoryReply?.();
          },
        },
      },
    };
  });
});
async function openServer(page: any) {
  await page.getByRole("button", { name: "选中会话 server" }).dblclick();
  await expect(page.getByLabel("当前对话")).toHaveValue("c1");
}
test("shared history streams across tabs and separate conversation selections stay independent", async ({
  page,
}) => {
  await page.goto("/");
  await openServer(page);
  await expect(page.getByText("历史记录已恢复")).toBeVisible();
  await page.getByLabel("发送给 AI").fill("检查 Redis");
  await page.getByTitle("发送消息", { exact: true }).click();
  await expect(page.getByText("共享的流式回复")).toBeVisible();
  await page.getByTitle("双击复制会话").dblclick();
  await expect(page.locator(".terminal-tab")).toHaveCount(2);
  await expect(page.getByText("正在另一标签页运行")).toBeVisible();
  await page.getByLabel("发送给 AI").fill("不能同时发送");
  await expect(page.getByTitle("发送消息", { exact: true })).toBeDisabled();
  await page.getByTitle("新建对话", { exact: true }).click();
  await expect(page.getByLabel("当前对话")).toHaveValue("c2");
  await page.locator(".terminal-tab > button:first-child").first().click();
  await expect(page.getByLabel("当前对话")).toHaveValue("c1");
  await page.evaluate(() => (window as any).__finishMemoryReply());
  await expect(page.getByText("共享回复已完成")).toBeVisible();
  await page.locator(".terminal-tab > button:first-child").nth(1).click();
  await expect(page.getByLabel("当前对话")).toHaveValue("c2");
  await page.getByLabel("当前对话").selectOption("c1");
  await expect(page.getByText("共享回复已完成")).toBeVisible();
  await page.screenshot({ path: "test-results/conversation-memory-dark.png" });
});
test("clear and delete synchronize viewers and renamed conversations restore after reload", async ({
  page,
}) => {
  await page.goto("/");
  await openServer(page);
  await page.getByTitle("双击复制会话").dblclick();
  await expect(page.locator(".terminal-tab")).toHaveCount(2);
  await page.getByTitle("清空对话", { exact: true }).click();
  await expect(
    page.getByText("所有查看此对话的标签页都会同步清空，其他对话不受影响。"),
  ).toBeVisible();
  await page
    .getByRole("alertdialog")
    .getByRole("button", { name: "清空对话", exact: true })
    .click();
  await expect(page.getByText("历史记录已恢复")).toHaveCount(0);
  await page.locator(".terminal-tab > button:first-child").first().click();
  await expect(page.getByText("历史记录已恢复")).toHaveCount(0);
  await page.getByTitle("删除对话", { exact: true }).click();
  await page
    .getByRole("alertdialog")
    .getByRole("button", { name: "删除对话", exact: true })
    .click();
  await expect(page.getByLabel("当前对话")).toHaveValue("c2");
  await page.locator(".terminal-tab > button:first-child").nth(1).click();
  await expect(page.getByLabel("当前对话")).toHaveValue("c2");
  await page.getByTitle("重命名对话").click();
  await page.getByLabel("对话标题").fill("部署项目");
  await page.getByRole("button", { name: "保存修改", exact: true }).click();
  await expect(page.getByLabel("当前对话")).toContainText("部署项目");
  await page.reload();
  await page.getByRole("button", { name: "选中会话 server" }).dblclick();
  await expect(page.getByLabel("当前对话")).toHaveValue("c2");
  await expect(page.getByLabel("当前对话")).toContainText("部署项目");
});
test("English light theme keeps the conversation toolbar compact", async ({
  page,
}) => {
  await page.goto("/?language=en&theme=light");
  await page.getByRole("button", { name: "Select session server" }).dblclick();
  await expect(page.getByLabel("Current conversation")).toBeVisible();
  await expect(
    page.getByTitle("New conversation", { exact: true }),
  ).toBeVisible();
  const toolbar = await page.locator(".conversation-picker").boundingBox();
  expect(toolbar!.height).toBeLessThanOrEqual(40);
  await page.screenshot({ path: "test-results/conversation-memory-light.png" });
});
