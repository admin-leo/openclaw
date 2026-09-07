import { expect, it } from "vitest";
import { createChatFlowE2eSuite, installMockGateway } from "./chat-flow.test-support.ts";

const suite = createChatFlowE2eSuite();
suite.define(() => {
  it("reveals bookmarked sources while preserving live tool and commentary controls", async () => {
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
            __openclaw: { id: "bookmark-source-" + index, seq: index * 4 + 1 },
            role: index % 2 ? "assistant" : "user",
            content: [{ type: "text", text: "Bookmark checkpoint " + index }],
            timestamp: Date.UTC(2026, 8, 6, 12, index),
          })).flatMap((message, index) =>
            index === 31
              ? [
                  message,
                  {
                    role: "toolResult",
                    toolName: "read",
                    toolCallId: "hidden-tool-call",
                    content: [{ type: "text", text: "Hidden tool result" }],
                    timestamp: Date.UTC(2026, 8, 6, 12, 31, 10),
                    __openclaw: { id: "hidden-tool", seq: 126 },
                  },
                  {
                    role: "assistant",
                    content: [{ type: "text", text: "Hidden commentary" }],
                    openclawStreamFallback: {
                      replacementText: "Hidden commentary",
                      source: "segment",
                      itemId: "hidden-commentary",
                    },
                    timestamp: Date.UTC(2026, 8, 6, 12, 31, 20),
                    __openclaw: { id: "hidden-commentary", seq: 127 },
                  },
                  {
                    role: "assistant",
                    content: [{ type: "text", text: "Unrelated commentary" }],
                    openclawStreamFallback: {
                      replacementText: "Unrelated commentary",
                      source: "segment",
                      itemId: "other-commentary",
                    },
                    timestamp: Date.UTC(2026, 8, 6, 12, 31, 30),
                    __openclaw: { id: "other-commentary", seq: 128 },
                  },
                ]
              : [message],
          ),
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
                {
                  id: "hidden-note",
                  agentId: "main",
                  sessionKey: key,
                  sessionId,
                  messageId: "hidden-commentary",
                  name: "Hidden note",
                  createdAt: 2,
                  updatedAt: 2,
                },
              ],
            },
          },
        });
        await page.goto(suite.server.baseUrl + "chat");
        await page.locator('.chat-bubble[data-entry-id="bookmark-source-71"]').waitFor();
        const setView = async (value: "tool-calls" | "commentary", checked: boolean) => {
          await page.locator(".chat-header-session-menu__trigger").click();
          await page
            .locator('wa-dropdown-item:has(wa-dropdown-item[value="view:tool-calls"])')
            .hover();
          const item = page.locator('wa-dropdown-item[value="view:' + value + '"]:visible');
          await item.waitFor();
          if ((await item.getAttribute("aria-checked")) !== String(checked)) {
            await item.click();
          }
          await page.keyboard.press("Escape");
          await page
            .locator('wa-dropdown-item[value="view:tool-calls"]:visible')
            .waitFor({ state: "hidden" });
        };
        await setView("tool-calls", false);
        await setView("commentary", false);
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
        const hiddenTool = page.locator('.chat-bubble[data-entry-id="hidden-tool"]');
        const hiddenCommentary = page.locator('.chat-bubble[data-entry-id="hidden-commentary"]');
        await hiddenTool.waitFor({ state: "hidden" });
        await hiddenCommentary.waitFor({ state: "hidden" });
        for (const value of ["tool-calls", "commentary"] as const) {
          const message = value === "tool-calls" ? hiddenTool : hiddenCommentary;
          await setView(value, true);
          await message.waitFor({ state: "visible" });
          await setView(value, false);
          await message.waitFor({ state: "hidden" });
        }
        await page.locator(".chat-header-session-menu__trigger").click();
        await page.locator('wa-dropdown-item[value="open-bookmarks"]:visible').click();
        await page.getByRole("button", { name: "Hidden note", exact: true }).click();
        await hiddenCommentary.waitFor({ state: "visible" });
        await hiddenCommentary.hover();
        await hiddenTool.waitFor({ state: "hidden" });
        await page
          .locator('.chat-bubble[data-entry-id="other-commentary"]')
          .waitFor({ state: "hidden" });
        expect(await page.locator("openclaw-modal-dialog").count()).toBe(0);
      },
    );
  });
});
