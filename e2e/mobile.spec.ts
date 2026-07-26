import { expect, test, type Page } from "@playwright/test";

const bootstrapFixture = {
  csrfToken: "test-csrf",
  projects: [{ id: "p1", name: "Codex-Control", path: "D:\\repo\\codex-control", selected: true }],
  threads: [{
    id: "t1",
    title: "实现手机远程控制",
    cwd: "D:\\repo\\codex-control",
    projectId: "p1",
    model: "gpt-5.6-sol",
    reasoningEffort: "high",
    createdAt: "2026-07-26T02:00:00.000Z",
    updatedAt: "2026-07-26T03:00:00.000Z",
    origin: "web",
    controlMode: "full",
    state: "running",
    activeTurnId: "turn-1",
  }],
  models: [{
    id: "gpt-5.6-sol",
    model: "gpt-5.6-sol",
    displayName: "GPT-5.6 Sol",
    description: "Frontier coding model",
    isDefault: true,
    defaultReasoningEffort: "high",
    supportedReasoningEfforts: ["low", "medium", "high", "xhigh"],
  }],
  approvals: [{
    id: "approval-1",
    threadId: "t1",
    turnId: "turn-1",
    kind: "command",
    title: "Run command",
    detail: "pnpm test",
    createdAt: "2026-07-26T03:00:01.000Z",
  }],
  status: {
    codex: "connected",
    tunnel: "connected",
    tunnelUrl: "https://codex.example.com",
    codexVersion: "0.146.0-alpha.3",
    expectedCodexVersion: "0.146.0-alpha.3",
    desktopSync: "connected",
  },
  eventSequence: 14,
};

const threadFixture = {
  ...bootstrapFixture.threads[0],
  items: [
    { id: "u1", threadId: "t1", turnId: "turn-1", kind: "user-message", timestamp: "2026-07-26T03:00:00.000Z", text: "实现手机远程控制" },
    { id: "a1", threadId: "t1", turnId: "turn-1", kind: "agent-message", timestamp: "2026-07-26T03:00:01.000Z", text: "正在连接 Codex app-server。", phase: "commentary" },
    { id: "c1", threadId: "t1", turnId: "turn-1", kind: "command", timestamp: "2026-07-26T03:00:02.000Z", text: "Tests passed", command: "pnpm test", status: "completed", exitCode: 0 },
  ],
};

test("paired mobile workspace exposes daily controls", async ({ page }) => {
  await installWorkspaceRoutes(page);
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "实现手机远程控制" })).toBeVisible();
  await expect(page.getByText("正在连接 Codex app-server。")).toBeVisible();
  await expect(page.getByRole("button", { name: "停止任务" })).toBeVisible();
  await expect(page.getByRole("button", { name: "批准" })).toBeVisible();

  await page.getByRole("button", { name: "打开会话列表" }).click();
  await expect(page.getByRole("button", { name: "新建对话" })).toBeVisible();
});

test("first pairing works with a manual one-time code", async ({ page }) => {
  let paired = false;
  await page.route("**/api/bootstrap", async (route) => {
    if (!paired) await route.fulfill({ status: 401, contentType: "application/json", body: JSON.stringify({ error: "Pairing required" }) });
    else await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(bootstrapFixture) });
  });
  await page.route("**/api/auth/pair", async (route) => {
    paired = true;
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ csrfToken: "test-csrf", device: { id: "d1", name: "Phone" } }) });
  });
  await page.route("**/api/threads/t1", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(threadFixture) }));
  await page.goto("/#code=123456789");
  await expect(page.getByRole("heading", { name: "连接到 Codex Control" })).toBeVisible();
  await page.getByRole("button", { name: "配对设备" }).click();
  await expect(page.getByRole("heading", { name: "实现手机远程控制" })).toBeVisible();
  await expect(page).not.toHaveURL(/#code=/);
});

async function installWorkspaceRoutes(page: Page) {
  await page.route("**/api/bootstrap", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(bootstrapFixture) }));
  await page.route("**/api/threads/t1", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(threadFixture) }));
  await page.route("**/api/approvals/approval-1/resolve", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true }) }));
  await page.route("**/api/threads/t1/interrupt", (route) => route.fulfill({ status: 202, contentType: "application/json", body: JSON.stringify({ ok: true }) }));
}
