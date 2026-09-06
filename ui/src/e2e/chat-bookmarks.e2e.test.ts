import { expect, it } from "vitest";
import { createChatFlowE2eSuite, installMockGateway } from "./chat-flow.test-support.ts";

const suite = createChatFlowE2eSuite();
suite.define(() => {
  it("reveals a virtualized bookmarked source without reopening an unavailable dialog", async () => {
    await suite.withPage(
      { colorScheme: "dark", viewport: { width: 1440, height: 900 }, serviceWorkers: "block" },
      async ({ page }) => {
        const key = "agent:main:main";
        const sessionId = "bookmark-generation";
        await installMockGateway(page, {
          sessionKey: key,
          agentModel: "example/example-model",
          models: [{ id: "example-model", provider: "example", name: "Example model" }],
          presenceUsers: [
            {
              self: true,
              id: "reader",
              name: "Example user",
              identity: { type: "profile", id: "reader" },
            },
          ],
          sessions: [
            {
              key,
              sessionId,
              kind: "direct",
              label: "Bookmarks",
              model: "example-model",
              modelProvider: "example",
            },
          ],
          historyMessages: Array.from({ length: 72 }, (_, index) => ({
            __openclaw: { id: "bookmark-source-" + index, seq: index + 1 },
            role: index % 2 ? "assistant" : "user",
            content: [{ type: "text", text: "Bookmark checkpoint " + index }],
            timestamp: Date.UTC(2026, 8, 6, 12, index),
          })),
          methodResponses: {
            "chat.bookmarks.list": {
              bookmarks: [
                {
                  id: "decision",
                  agentId: "main",
                  sessionKey: key,
                  sessionId,
                  messageId: "bookmark-source-31",
                  name: "Architecture decision",
                  createdAt: 1,
                  updatedAt: 1,
                },
              ],
            },
          },
        });
        await page.goto(suite.server.baseUrl + "chat");
        await page.locator('.chat-bubble[data-entry-id="bookmark-source-71"]').waitFor();
        await page.locator(".chat-header-session-menu__trigger").click();
        await page.locator('wa-dropdown-item[value="open-bookmarks"]:visible').click();
        await page.getByRole("button", { name: "Architecture decision", exact: true }).click();
        const source = page.locator('.chat-bubble[data-entry-id="bookmark-source-31"]');
        await source.waitFor({ state: "visible" });
        // A row behind a reopened modal is not a successful navigation outcome.
        await source.hover();
        expect(await page.locator("openclaw-modal-dialog").count()).toBe(0);
        await expect
          .poll(() =>
            source.evaluate((element) => {
              const viewport = element.closest(".chat-thread")!.getBoundingClientRect();
              const rect = element.getBoundingClientRect();
              return rect.top >= viewport.top && rect.bottom <= viewport.bottom;
            }),
          )
          .toBe(true);
        expect(
          await page.locator(".chat-position-rail__marker--bookmark .claw-icon__jaw").count(),
        ).toBeGreaterThan(0);
      },
    );
  });
});
