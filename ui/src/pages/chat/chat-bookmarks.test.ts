/* @vitest-environment jsdom */
import { describe, expect, it, vi } from "vitest";
import type { ChatBookmark } from "../../../../packages/gateway-protocol/src/index.js";
import { createTestGatewayClient } from "../../test-helpers/gateway-client.ts";
import { ChatBookmarks, type ChatBookmarkScope } from "./chat-bookmarks.ts";

const bookmark: ChatBookmark = {
  id: "saved",
  agentId: "main",
  sessionKey: "agent:main:chat",
  sessionId: "generation-a",
  messageId: "source",
  name: "Decision",
  createdAt: 1,
  updatedAt: 1,
};
function scope(request: Parameters<typeof createTestGatewayClient>[0]): ChatBookmarkScope {
  return {
    client: createTestGatewayClient(request),
    generation: 1,
    profileId: "alice",
    agentId: "main",
    key: bookmark.sessionKey,
    sessionId: bookmark.sessionId,
    canWrite: true,
    isCurrent: () => true,
  };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("durable chat bookmarks", () => {
  it("does not treat an unread or failed bookmark index as an empty saved state", async () => {
    const pending = deferred<{ bookmarks: ChatBookmark[] }>();
    const state = new ChatBookmarks(vi.fn());
    state.bind(scope(() => pending.promise));
    state.toggle(bookmark.messageId);
    state.edit(bookmark.messageId);
    expect(state.editor).toBeNull();
    pending.resolve({ bookmarks: [bookmark] });
    await vi.waitFor(() => expect(state.indexReady).toBe(true));
    state.bind(
      scope(async () => {
        throw new Error("Read unavailable");
      }),
    );
    await vi.waitFor(() => expect(state.error).toContain("Read unavailable"));
    expect(state.indexReady).toBe(false);
    state.toggle(bookmark.messageId);
    expect(state.editor).toBeNull();
  });

  it("shows a failed footer removal without discarding its saved reference", async () => {
    const state = new ChatBookmarks(vi.fn());
    state.bind(
      scope(async (method) => {
        if (method === "chat.bookmarks.remove") {
          throw new Error("Removal unavailable");
        }
        return { bookmarks: [bookmark] };
      }),
    );
    await vi.waitFor(() => expect(state.indexReady).toBe(true));
    expect(state.open).toBe(false);
    state.toggle(bookmark.messageId);
    await vi.waitFor(() => expect(state.error).toContain("Removal unavailable"));
    expect(state.open).toBe(true);
    expect(state.bookmarks).toEqual([bookmark]);
    expect(state.saving).toBe(false);
  });

  it("toggles a saved source off without opening rename, and opens naming for an unsaved source", async () => {
    let rows = [bookmark];
    const request = vi.fn(async (method) => {
      if (method === "chat.bookmarks.remove") {
        rows = [];
        return { ok: true };
      }
      return { bookmarks: rows };
    });
    const state = new ChatBookmarks(vi.fn());
    state.bind(scope(request));
    await vi.waitFor(() => expect(state.bookmarks).toEqual([bookmark]));
    state.toggle(bookmark.messageId);
    await vi.waitFor(() => expect(state.bookmarks).toEqual([]));
    expect(request).toHaveBeenCalledWith("chat.bookmarks.remove", { bookmarkId: bookmark.id });
    expect(state.editor).toBeNull();
    state.toggle(bookmark.messageId);
    expect(state.editor).toEqual({
      messageId: bookmark.messageId,
      bookmarkId: undefined,
      name: "",
    });
  });

  it("lists and removes references from deleted conversations through the profile library", async () => {
    const unavailable = {
      ...bookmark,
      sessionKey: "agent:main:deleted",
      sessionId: "deleted-generation",
    };
    const request = vi.fn(async () => ({ bookmarks: [unavailable] }));
    const state = new ChatBookmarks(vi.fn());
    state.bind(scope(request));
    state.allConversations = true;
    await state.search("decision");
    expect(request).toHaveBeenLastCalledWith("chat.bookmarks.list", { query: "decision" });
    expect(state.results).toEqual([unavailable]);
    await state.remove(unavailable);
    expect(request).toHaveBeenCalledWith("chat.bookmarks.remove", { bookmarkId: unavailable.id });
  });

  it.each(["profile", "connection", "session", "agent", "generation", "disconnect"])(
    "discards in-flight list results after a %s change",
    async (change) => {
      const pending = deferred<{ bookmarks: ChatBookmark[] }>();
      const state = new ChatBookmarks(vi.fn());
      const owner = scope(() => pending.promise);
      state.bind(owner);
      const replacement = {
        ...owner,
        client: createTestGatewayClient(async () => ({ bookmarks: [] })),
      };
      if (change === "profile") {
        replacement.profileId = "bob";
      }
      if (change === "connection") {
        replacement.generation++;
      }
      if (change === "session") {
        replacement.key = "agent:main:other";
      }
      if (change === "agent") {
        replacement.agentId = "other";
      }
      if (change === "generation") {
        replacement.sessionId = "generation-b";
      }
      state.bind(change === "disconnect" ? null : replacement);
      pending.resolve({ bookmarks: [bookmark] });
      await pending.promise;
      await Promise.resolve();
      expect(state.bookmarks).toEqual([]);
      expect(state.results).toEqual([]);
    },
  );

  it("loads every index page and preserves an explicit next-page action for search", async () => {
    const second = { ...bookmark, id: "saved-2", messageId: "source-2", name: "Follow-up" };
    const request = vi.fn(async (_method, params) => {
      const args = params as { cursor?: string; limit?: number };
      return args.cursor
        ? { bookmarks: [second] }
        : { bookmarks: [bookmark], nextCursor: "page-2" };
    });
    const state = new ChatBookmarks(vi.fn());
    state.bind(scope(request));
    await vi.waitFor(() => expect(state.bookmarks).toHaveLength(2));
    await state.search("decision");
    expect(state.results).toEqual([bookmark]);
    expect(state.nextCursor).toBe("page-2");
    await state.search("decision", true);
    expect(state.results).toEqual([bookmark, second]);
    expect(state.nextCursor).toBeUndefined();
    expect(request).toHaveBeenLastCalledWith("chat.bookmarks.list", {
      key: bookmark.sessionKey,
      agentId: bookmark.agentId,
      query: "decision",
      cursor: "page-2",
    });
  });

  it("does not let a slow search replace a later query", async () => {
    const pending = deferred<{ bookmarks: ChatBookmark[] }>();
    const state = new ChatBookmarks(vi.fn());
    state.bind(
      scope(async (_method, params) =>
        (params as { query?: string }).query === "old" ? pending.promise : { bookmarks: [] },
      ),
    );
    const old = state.search("old");
    await state.search("new");
    pending.resolve({ bookmarks: [bookmark] });
    await old;
    expect(state.query).toBe("new");
    expect(state.results).toEqual([]);
    expect(state.loading).toBe(false);
  });

  it("creates by durable source and session generation, accepts 70 Unicode characters, and reloads after rename/remove", async () => {
    let saved: ChatBookmark[] = [];
    const request = vi.fn(async (method, params) => {
      const args = params as { name: string };
      if (method === "chat.bookmarks.create" || method === "chat.bookmarks.rename") {
        saved = [{ ...bookmark, name: args.name }];
        return { bookmark: saved[0] };
      }
      if (method === "chat.bookmarks.remove") {
        saved = [];
        return { ok: true };
      }
      return { bookmarks: saved };
    });
    const state = new ChatBookmarks(vi.fn());
    state.bind(scope(request));
    await vi.waitFor(() => expect(state.indexReady).toBe(true));
    state.edit("source");
    state.editor!.name = "🦞".repeat(71);
    await state.save();
    expect(request.mock.calls.some(([method]) => method === "chat.bookmarks.create")).toBe(false);
    state.editor!.name = "🦞".repeat(70);
    await state.save();
    expect(request).toHaveBeenCalledWith("chat.bookmarks.create", {
      key: bookmark.sessionKey,
      agentId: bookmark.agentId,
      sessionId: "generation-a",
      messageId: "source",
      name: "🦞".repeat(70),
    });
    expect(state.bookmarks[0]?.name).toBe("🦞".repeat(70));
    state.edit("source");
    state.editor!.name = "Renamed";
    await state.save();
    expect(request).toHaveBeenCalledWith("chat.bookmarks.rename", {
      bookmarkId: "saved",
      name: "Renamed",
    });
    expect(state.results[0]?.name).toBe("Renamed");
    await state.remove(state.results[0]!);
    expect(state.bookmarks).toEqual([]);
    expect(state.results).toEqual([]);
  });

  it("ignores a completed mutation after leaving and returning to the same scope", async () => {
    const pending = deferred<{ bookmark: ChatBookmark }>();
    const state = new ChatBookmarks(vi.fn());
    const owner = scope(async (method) =>
      method === "chat.bookmarks.create" ? pending.promise : { bookmarks: [] },
    );
    state.bind(owner);
    await vi.waitFor(() => expect(state.indexReady).toBe(true));
    state.edit("source");
    state.editor!.name = "Old save";
    const saving = state.save();
    state.bind({ ...owner, key: "other" });
    state.bind({ ...owner });
    await vi.waitFor(() => expect(state.indexReady).toBe(true));
    state.edit("new-source");
    state.editor!.name = "New draft";
    pending.resolve({ bookmark });
    await saving;
    expect(state.editor?.name).toBe("New draft");
    expect(state.saving).toBe(false);
  });

  it("shows durable failures and does not mutate a read-only or retired owner", async () => {
    const request = vi.fn(async () => {
      throw new Error("Storage unavailable");
    });
    const state = new ChatBookmarks(vi.fn());
    const owner = scope(request);
    state.bind({ ...owner, canWrite: false });
    await vi.waitFor(() => expect(state.error).toContain("Storage unavailable"));
    state.edit("source");
    expect(state.editor).toBeNull();
    request.mockClear();
    await state.remove(bookmark);
    expect(request).not.toHaveBeenCalled();
    state.bind({ ...owner, isCurrent: () => false });
    state.edit("source");
    expect(state.editor).toBeNull();
  });
});
