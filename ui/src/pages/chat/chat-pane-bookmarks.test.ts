/* @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ChatBookmark } from "../../../../packages/gateway-protocol/src/index.js";
import type { SessionCapability } from "../../lib/sessions/index.ts";
import { createTestGatewayClient } from "../../test-helpers/gateway-client.ts";
import { createTestChatPane, nativeHistoryMessage } from "./chat-pane-history.test-support.ts";

const bookmark: ChatBookmark = {
  id: "saved",
  agentId: "main",
  sessionKey: "agent:main:current",
  sessionId: "generation-a",
  messageId: "source",
  name: "Decision",
  createdAt: 1,
  updatedAt: 1,
};
const source = {
  ...nativeHistoryMessage(1, "Original answer"),
  __openclaw: { id: "source", seq: 1 },
};
function setup(request: Parameters<typeof createTestGatewayClient>[0]) {
  const result = createTestChatPane({
    client: createTestGatewayClient(request),
    sessions: {} as SessionCapability,
  });
  result.state.currentSessionId = bookmark.sessionId;
  result.pane.context.gateway.snapshot.selfUser = {
    id: "alice",
    name: "Alice",
    identity: { type: "profile", id: "alice" },
  };
  vi.spyOn(result.pane, "updateComplete", "get").mockReturnValue(Promise.resolve(true));
  return result;
}
afterEach(() => {
  vi.restoreAllMocks();
});

describe("bookmark pane navigation", () => {
  it("retires already-rendered actions when the profile is replaced", async () => {
    const { pane } = setup(async () => ({ bookmarks: [bookmark] }));
    pane.syncBookmarks();
    await vi.waitFor(() => expect(pane.bookmarks.indexReady).toBe(true));
    const access = pane.syncBookmarks()!;
    expect(access.edit).toBeTypeOf("function");
    expect(access.toggle).toBeTypeOf("function");
    pane.context.gateway.snapshot.selfUser = {
      id: "bob",
      identity: { type: "profile", id: "bob" },
    };
    pane.syncBookmarks();
    access.edit?.("source");
    access.open(bookmark);
    expect(pane.bookmarks.editor).toBeNull();
    expect(pane.bookmarks.open).toBe(false);
  });

  it("pages native history until the exact persisted source is present and requires visible-source completion", async () => {
    const request = vi.fn(async (method, params) => {
      if (method === "chat.bookmarks.list") {
        return { bookmarks: [bookmark] };
      }
      const offset = (params as { offset: number }).offset;
      return offset === 2
        ? {
            sessionId: bookmark.sessionId,
            messages: [nativeHistoryMessage(3), nativeHistoryMessage(4)],
            hasMore: true,
            nextOffset: 4,
            totalMessages: 6,
          }
        : {
            sessionId: bookmark.sessionId,
            messages: [source, nativeHistoryMessage(2)],
            hasMore: false,
            totalMessages: 6,
          };
    });
    const { pane, state } = setup(request);
    state.chatMessages = [nativeHistoryMessage(5), nativeHistoryMessage(6)];
    state.chatHistoryPagination = { hasMore: true, nextOffset: 2, totalMessages: 6 };
    const reveal = vi.spyOn(pane.transcript, "revealMessage").mockImplementation((_id, options) => {
      expect(options?.isCurrent()).toBe(true);
      options?.onRevealed(true);
      return true;
    });
    pane.syncBookmarks()!.open(bookmark);
    await vi.waitFor(() => expect(reveal).toHaveBeenCalledWith("source", expect.any(Object)));
    expect(state.chatMessages).toContain(source);
    expect(pane.bookmarks.revealId).toBe("source");
    expect(pane.bookmarks.error).toBeNull();
    expect(request).toHaveBeenCalledWith("chat.history", expect.objectContaining({ offset: 4 }));
  });

  it.each(["profile", "connection", "generation", "session"])(
    "abandons a paginating jump when its %s changes",
    async (change) => {
      let finish!: (result: unknown) => void;
      const page = new Promise((resolve) => {
        finish = resolve;
      });
      const request = vi.fn(async (method) =>
        method === "chat.bookmarks.list" ? { bookmarks: [bookmark] } : page,
      );
      const { pane, state } = setup(request);
      state.chatMessages = [nativeHistoryMessage(3)];
      state.chatHistoryPagination = { hasMore: true, nextOffset: 1, totalMessages: 3 };
      const reveal = vi.spyOn(pane.transcript, "revealMessage");
      pane.syncBookmarks()!.open(bookmark);
      await vi.waitFor(() =>
        expect(request.mock.calls.some(([method]) => method === "chat.history")).toBe(true),
      );
      if (change === "profile") {
        pane.context.gateway.snapshot.selfUser = {
          id: "bob",
          identity: { type: "profile", id: "bob" },
        };
      }
      if (change === "connection") {
        pane.connectionGeneration++;
      }
      if (change === "generation") {
        state.currentSessionId = "generation-b";
      }
      if (change === "session") {
        state.sessionKey = "agent:main:other";
      }
      finish({
        sessionId: bookmark.sessionId,
        messages: [source],
        hasMore: false,
        totalMessages: 3,
      });
      await page;
      await Promise.resolve();
      await Promise.resolve();
      expect(reveal).not.toHaveBeenCalled();
      expect(pane.bookmarks.selectedId).toBeNull();
    },
  );

  it("never retargets a replacement generation with the same entry ID", () => {
    const { pane, state } = setup(async () => ({ bookmarks: [bookmark] }));
    state.currentSessionId = "generation-b";
    state.chatMessages = [source];
    const reveal = vi.spyOn(pane.transcript, "revealMessage");
    pane.syncBookmarks()!.open(bookmark);
    expect(reveal).not.toHaveBeenCalled();
    expect(pane.bookmarks.unavailable.has(bookmark.id)).toBe(true);
    expect(pane.bookmarks.open).toBe(true);
  });

  it("reports an indexed but non-visible target instead of silently claiming navigation succeeded", async () => {
    const { pane, state } = setup(async () => ({ bookmarks: [bookmark] }));
    state.chatMessages = [source];
    vi.spyOn(pane.transcript, "revealMessage").mockImplementation((_id, options) => {
      options?.onRevealed(false);
      return true;
    });
    pane.syncBookmarks()!.open(bookmark);
    await vi.waitFor(() => expect(pane.bookmarks.error).toContain("Original message unavailable"));
    expect(pane.bookmarks.open).toBe(true);
  });

  it.each(["no profile", "incognito key", "incognito projection", "no durable generation"])(
    "does not expose bookmarks for %s",
    (reason) => {
      const { pane, state } = setup(async () => ({ bookmarks: [] }));
      if (reason === "no profile") {
        pane.context.gateway.snapshot.selfUser = null;
      }
      if (reason === "incognito key") {
        state.sessionKey = "agent:main:dashboard:incognito-test";
      }
      if (reason === "incognito projection") {
        state.selectedChatSessionIncognito = true;
      }
      if (reason === "no durable generation") {
        state.currentSessionId = null;
      }
      expect(pane.syncBookmarks()).toBeUndefined();
    },
  );
});
