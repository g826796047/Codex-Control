import { once } from "node:events";
import { describe, expect, it } from "vitest";
import { CodexRpcClient, type JsonRpcNotification, type JsonRpcRequest } from "../src/codex/json-rpc.js";

const mockScript = String.raw`
  const readline = require("node:readline");
  const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  rl.on("line", line => {
    const message = JSON.parse(line);
    if (message.method === "initialize") {
      process.stdout.write(JSON.stringify({ id: message.id, result: { userAgent: "mock" } }) + "\n");
      process.stdout.write(JSON.stringify({ method: "item/agentMessage/delta", params: { threadId: "t1", itemId: "i1", delta: "hello" } }) + "\n");
      process.stdout.write(JSON.stringify({ id: "approval-1", method: "item/commandExecution/requestApproval", params: { threadId: "t1", command: "npm test" } }) + "\n");
    } else if (message.method === "model/list") {
      process.stdout.write(JSON.stringify({ id: message.id, result: { data: [{ id: "m1" }] } }) + "\n");
    } else if (message.id === "approval-1" && message.result) {
      process.stdout.write(JSON.stringify({ method: "serverRequest/resolved", params: { requestId: "approval-1", result: message.result } }) + "\n");
    } else if (message.method === "never/respond") {
      setTimeout(() => process.exit(2), 20);
    }
  });
`;

describe("CodexRpcClient", () => {
  it("handles requests, notifications and server approval responses", async () => {
    const client = new CodexRpcClient(process.execPath, 1_000, ["-e", mockScript]);
    const notifications: JsonRpcNotification[] = [];
    client.on("notification", (message: JsonRpcNotification) => notifications.push(message));
    const approvalPromise = once(client, "request") as Promise<[JsonRpcRequest]>;
    await client.start();
    await expect(client.request("initialize", {})).resolves.toMatchObject({ userAgent: "mock" });
    const [approval] = await approvalPromise;
    expect(approval.method).toContain("requestApproval");
    client.respond(approval.id, { decision: "accept" });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(notifications.some((message) => message.method === "item/agentMessage/delta")).toBe(true);
    expect(notifications.some((message) => message.method === "serverRequest/resolved")).toBe(true);
    await expect(client.request<{ data: Array<{ id: string }> }>("model/list", {})).resolves.toEqual({ data: [{ id: "m1" }] });
    await client.stop();
  });

  it("rejects pending work when app-server crashes without replaying it", async () => {
    const client = new CodexRpcClient(process.execPath, 1_000, ["-e", mockScript]);
    await client.start();
    await expect(client.request("never/respond", {})).rejects.toThrow(/exited|closed/i);
  });
});
