/* @vitest-environment jsdom */
import { render } from "lit";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ChatBookmark } from "../../../../../packages/gateway-protocol/src/index.js";
import { createTestGatewayClient } from "../../../test-helpers/gateway-client.ts";
import { ChatBookmarks } from "../chat-bookmarks.ts";
import { renderChatBookmarksDialog } from "./chat-bookmarks-dialog.ts";
import "./chat-header-session-menu.ts";

const bookmark: ChatBookmark = {
  id: "saved",
  agentId: "main",
  sessionKey: "agent:main:chat",
  sessionId: "old-generation",
  messageId: "source",
  name: "Old decision",
  createdAt: 1,
  updatedAt: 1,
};
afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

describe("native bookmark dialog", () => {
  it.each([false, true])(
    "opens Bookmarks from the existing root menu (compact=%s)",
    async (compact) => {
      const menu = document.createElement("openclaw-chat-header-session-menu");
      menu.compact = compact;
      menu.onOpenBookmarks = vi.fn();
      document.body.append(menu);
      await menu.updateComplete;
      const item = menu.querySelector('wa-dropdown-item[value="open-bookmarks"]');
      expect(item?.textContent).toContain("Bookmarks");
      expect(item?.closest('[slot="submenu"]')).toBeNull();
      expect(menu.querySelector(".chat-header-session-menu__trigger")?.textContent).not.toContain(
        "Bookmarks",
      );
      menu.querySelector("wa-dropdown")!.dispatchEvent(
        new CustomEvent("wa-select", {
          detail: { item: { value: "open-bookmarks" } },
          bubbles: true,
        }),
      );
      expect(menu.onOpenBookmarks).toHaveBeenCalledOnce();
    },
  );

  it("keeps unavailable generations visible and removable, searches durably, and exposes remaining pages", async () => {
    const request = vi.fn(async (method, params) => {
      if (method === "chat.bookmarks.remove") {
        return { ok: true };
      }
      const args = params as { limit?: number; cursor?: string };
      return {
        bookmarks: [bookmark],
        ...(args.limit || args.cursor ? {} : { nextCursor: "next" }),
      };
    });
    const state = new ChatBookmarks(vi.fn());
    state.bind({
      client: createTestGatewayClient(request),
      generation: 1,
      profileId: "alice",
      agentId: "main",
      key: bookmark.sessionKey,
      sessionId: "new-generation",
      canWrite: true,
      isCurrent: () => true,
    });
    await state.search("");
    state.open = true;
    const container = document.body.appendChild(document.createElement("div"));
    const actions = { open: vi.fn(), update: vi.fn() };
    const draw = () => render(renderChatBookmarksDialog(state, actions), container);
    draw();
    expect(container.querySelector("openclaw-modal-dialog")).not.toBeNull();
    expect(container.textContent).toContain("Original message unavailable");
    const source = [...container.querySelectorAll<HTMLButtonElement>("button")].find((button) =>
      button.textContent?.includes("Old decision"),
    );
    expect(source?.disabled).toBe(true);
    const search = container.querySelector<HTMLInputElement>('input[type="search"]')!;
    search.value = "decision";
    search.dispatchEvent(new Event("input", { bubbles: true }));
    await vi.waitFor(() =>
      expect(request).toHaveBeenCalledWith("chat.bookmarks.list", {
        key: bookmark.sessionKey,
        agentId: bookmark.agentId,
        query: "decision",
      }),
    );
    await vi.waitFor(() => expect(state.loading).toBe(false));
    draw();
    [...container.querySelectorAll<HTMLButtonElement>("button")]
      .find((button) => button.textContent?.includes("Load more"))!
      .click();
    await vi.waitFor(() =>
      expect(request).toHaveBeenCalledWith("chat.bookmarks.list", {
        key: bookmark.sessionKey,
        agentId: bookmark.agentId,
        query: "decision",
        cursor: "next",
      }),
    );
    // A reload owns fresh result identity, not local browser storage.
    await state.search("decision");
    draw();
    [...container.querySelectorAll<HTMLButtonElement>("button")]
      .find((button) => button.textContent?.includes("Remove bookmark"))!
      .click();
    await vi.waitFor(() =>
      expect(request).toHaveBeenCalledWith("chat.bookmarks.remove", { bookmarkId: "saved" }),
    );
  });
});
