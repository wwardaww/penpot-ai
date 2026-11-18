import { test, expect } from "@playwright/test";
import { WorkspacePage } from "../pages/WorkspacePage";

// W11: the AI chat panel against a scripted daemon. The workspace suite replaces
// `window.WebSocket` with MockWebSocket, so the daemon socket
// (ws://127.0.0.1:4410/agent) is answered through the same helper, not through
// page.routeWebSocket. The script follows mcp/packages/common agent-protocol.ts.

const AGENT_URL = "ws://127.0.0.1:4410/agent";
const REPLY = ["Hello from the ", "stubbed daemon."];

test.beforeEach(async ({ page }) => {
  await WorkspacePage.init(page);
  // the AI flag opens the chat panel as the default left sidebar layout
  await WorkspacePage.mockConfigFlags(page, ["enable-ai"]);
});

/**
 * Answers the daemon protocol: auth, history and one chat turn.
 *
 * @returns {object[]} the messages the client sent, in order
 */
async function scriptDaemon(workspacePage) {
  const sent = [];
  const agent = await workspacePage.waitForWebSocket(AGENT_URL);
  const reply = (message) => agent.mockMessage(JSON.stringify(message));

  agent.addEventListener("message", async (event) => {
    const message = JSON.parse(event.data);
    sent.push(message);
    switch (message.type) {
      case "auth":
        await reply({ type: "auth.ok", daemonVersion: "0.1.0-e2e" });
        break;
      case "chat.history":
        await reply({
          type: "chat.history",
          rid: message.rid,
          conversationId: message.conversationId,
          messages: [],
        });
        break;
      case "chat.send": {
        const { conversationId } = message;
        const messageId = "e2e-message-1";
        await reply({
          type: "chat.tool",
          conversationId,
          toolName: "mcp__penpot__get_node_properties",
          summary: "Reading the design",
          status: "running",
        });
        await reply({
          type: "chat.tool",
          conversationId,
          toolName: "mcp__penpot__get_node_properties",
          summary: "Reading the design",
          status: "done",
        });
        for (const text of REPLY) {
          await reply({ type: "chat.delta", conversationId, messageId, text });
        }
        await reply({ type: "chat.done", conversationId, messageId });
        break;
      }
      default:
        break;
    }
  });

  await agent.mockOpen();
  return sent;
}

test("AI chat panel shows a streamed answer from the daemon", async ({
  page,
}) => {
  const workspacePage = new WorkspacePage(page);
  await workspacePage.setupEmptyFile();
  // not goToWorkspace: it waits for the sitemap's page name, which the AI
  // layout hides
  await page.goto(
    `/?screen=workspace&team-id=${WorkspacePage.anyTeamId}&file-id=${WorkspacePage.anyFileId}&page-id=${WorkspacePage.anyPageId}`,
  );
  const notifications = await workspacePage.waitForNotificationsWebSocket();
  await notifications.mockOpen();

  const sent = await scriptDaemon(workspacePage);
  const panel = page.getByTestId("ai-chat-panel");
  await expect(panel).toBeVisible({ timeout: 30000 });
  await expect
    .poll(() => sent.some((message) => message.type === "auth"))
    .toBe(true);

  const input = panel.getByRole("textbox", { name: "Message to the AI" });
  await input.fill("make the button blue");
  await panel.getByRole("button", { name: "Send" }).click();

  await expect(panel.getByText("make the button blue")).toBeVisible();
  await expect(panel.getByText(REPLY.join(""))).toBeVisible();

  const auth = sent.find((message) => message.type === "auth");
  expect(auth).toBeDefined();
  const send = sent.find((message) => message.type === "chat.send");
  expect(send?.text).toBe("make the button blue");
});
