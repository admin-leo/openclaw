import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  ChatBookmarkError,
  createChatBookmark,
  listChatBookmarks,
  renameChatBookmark,
  removeChatBookmark,
  type ChatBookmarkSource,
} from "./chat-bookmarks.js";
import { tableExists } from "./openclaw-state-db-schema-helpers.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "./openclaw-state-db.js";
import { ensureProfileForEmail, linkEmail } from "./user-profiles.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => closeOpenClawStateDatabaseForTest());
const source: ChatBookmarkSource = {
  agentId: "main",
  sessionKey: "agent:main:bookmarks",
  sessionId: "generation-1",
  messageId: "message-1",
};
function fixture() {
  const options = { path: join(tempDirs.make("openclaw-bookmarks-"), "openclaw.sqlite") };
  const owner = ensureProfileForEmail("owner@example.test", options);
  const other = ensureProfileForEmail("other@example.test", options);
  return { options, owner, other };
}

describe("profile-owned chat bookmarks", () => {
  it("searches normalized Unicode labels and refreshes the bounded derivative on rename and upsert", () => {
    const { options, owner } = fixture();
    const first = createChatBookmark(owner.id, "Änderung", () => source, options);
    expect(listChatBookmarks(owner.id, { query: "ÄNDERUNG" }, options).bookmarks).toEqual([first]);
    expect(listChatBookmarks(owner.id, { query: "A\u0308nderung" }, options).bookmarks).toEqual([
      first,
    ]);
    const renamed = renameChatBookmark(owner.id, first.id, "Übersicht", options);
    expect(listChatBookmarks(owner.id, { query: "änderung" }, options).bookmarks).toEqual([]);
    expect(listChatBookmarks(owner.id, { query: "ÜBERSICHT" }, options).bookmarks).toEqual([
      renamed,
    ]);
    const updated = createChatBookmark(owner.id, "Öffnung", () => source, options);
    expect(listChatBookmarks(owner.id, { query: "übersicht" }, options).bookmarks).toEqual([]);
    expect(listChatBookmarks(owner.id, { query: "ÖFFNUNG" }, options).bookmarks).toEqual([updated]);
    const expanded = createChatBookmark(
      owner.id,
      "İ".repeat(70),
      () => ({ ...source, messageId: "unicode-expansion" }),
      options,
    );
    expect(listChatBookmarks(owner.id, { query: "i\u0307" }, options).bookmarks).toEqual([
      expanded,
    ]);
    closeOpenClawStateDatabaseForTest();
    expect(listChatBookmarks(owner.id, { query: "öffnung" }, options).bookmarks).toEqual([updated]);
  });
  it("creates storage only on successful admission, preserves schema version, and survives reopen", () => {
    const { options, owner } = fixture();
    const db = openOpenClawStateDatabase(options).db;
    const version = db.prepare("PRAGMA user_version").get()?.user_version;
    expect(listChatBookmarks(owner.id, {}, options)).toEqual({ bookmarks: [] });
    expect(tableExists(db, "chat_bookmarks")).toBe(false);
    expect(() =>
      createChatBookmark(
        owner.id,
        "unavailable",
        () => {
          throw new ChatBookmarkError("source unavailable");
        },
        options,
      ),
    ).toThrow("source unavailable");
    expect(tableExists(db, "chat_bookmarks")).toBe(false);
    const bookmark = createChatBookmark(owner.id, "  Useful answer  ", () => source, options);
    expect(bookmark).toMatchObject({ ...source, name: "Useful answer" });
    expect(db.prepare("PRAGMA user_version").get()?.user_version).toBe(version);
    closeOpenClawStateDatabaseForTest();
    expect(listChatBookmarks(owner.id, {}, options)).toEqual({ bookmarks: [bookmark] });
    expect(
      openOpenClawStateDatabase(options).db.prepare("PRAGMA integrity_check").get()
        ?.integrity_check,
    ).toBe("ok");
  });

  it("isolates ownership, deduplicates only identical sources, and permits removal without a readable source", () => {
    const { options, owner, other } = fixture();
    const first = createChatBookmark(owner.id, "First", () => source, options);
    const updated = createChatBookmark(owner.id, "Changed", () => source, options);
    expect(updated).toMatchObject({ id: first.id, createdAt: first.createdAt, name: "Changed" });
    expect(listChatBookmarks(other.id, {}, options).bookmarks).toEqual([]);
    expect(() => renameChatBookmark(other.id, first.id, "stolen", options)).toThrow("not found");
    removeChatBookmark(other.id, first.id, options);
    const reset = createChatBookmark(
      owner.id,
      "New generation",
      () => ({ ...source, sessionId: "generation-2" }),
      options,
    );
    expect(reset.id).not.toBe(first.id);
    expect(listChatBookmarks(owner.id, {}, options).bookmarks).toHaveLength(2);
    // Rename/remove depend solely on ownership, not a still-readable transcript.
    expect(renameChatBookmark(owner.id, first.id, "Unavailable reference", options).sessionId).toBe(
      "generation-1",
    );
    removeChatBookmark(owner.id, first.id, options);
    removeChatBookmark(owner.id, first.id, options);
    expect(listChatBookmarks(owner.id, {}, options).bookmarks).toEqual([reset]);
  });

  it("merges distinct references without a preference quota and keeps target labels only for identical sources", () => {
    const { options, owner, other } = fixture();
    const target = createChatBookmark(owner.id, "Target choice", () => source, options);
    createChatBookmark(other.id, "Source choice", () => source, options);
    const oldGeneration = createChatBookmark(
      other.id,
      "Older generation",
      () => ({ ...source, sessionId: "generation-0" }),
      options,
    );
    for (let i = 0; i < 130; i++) {
      createChatBookmark(
        other.id,
        "Item " + i,
        () => ({ ...source, messageId: "distinct-" + i }),
        options,
      );
    }
    linkEmail("other@example.test", owner.id, options);
    const first = listChatBookmarks(owner.id, { limit: 100 }, options);
    const second = listChatBookmarks(owner.id, { limit: 100, cursor: first.nextCursor }, options);
    const all = [...first.bookmarks, ...second.bookmarks];
    expect(all).toHaveLength(132);
    expect(all).toContainEqual(target);
    expect(all).toContainEqual(oldGeneration);
    expect(all.some((row) => row.name === "Source choice")).toBe(false);
    expect(listChatBookmarks(other.id, {}, options)).toEqual(
      listChatBookmarks(owner.id, {}, options),
    );
    expect(renameChatBookmark(other.id, oldGeneration.id, "Alias resolves", options).name).toBe(
      "Alias resolves",
    );
  });

  it("bounds pages, searches literal labels, and counts Unicode characters rather than UTF-16 units", () => {
    const { options, owner } = fixture();
    const unicode = createChatBookmark(owner.id, "🦞".repeat(70), () => source, options);
    expect(unicode.name).toBe("🦞".repeat(70));
    for (const name of [" ", "🦞".repeat(71), "bad\0name"]) {
      expect(() => renameChatBookmark(owner.id, unicode.id, name, options)).toThrow(
        ChatBookmarkError,
      );
    }
    for (let i = 0; i < 51; i++) {
      createChatBookmark(
        owner.id,
        i === 0 ? "100% useful" : "Answer " + i,
        () => ({ ...source, messageId: "page-" + i }),
        options,
      );
    }
    const page = listChatBookmarks(owner.id, {}, options);
    expect(page.bookmarks).toHaveLength(50);
    const next = listChatBookmarks(owner.id, { cursor: page.nextCursor }, options);
    expect(new Set([...page.bookmarks, ...next.bookmarks].map((row) => row.id)).size).toBe(52);
    expect(next.nextCursor).toBeUndefined();
    expect(
      listChatBookmarks(owner.id, { query: "%" }, options).bookmarks.map((row) => row.name),
    ).toEqual(["100% useful"]);
    expect(listChatBookmarks(owner.id, { key: "agent:other:main" }, options).bookmarks).toEqual([]);
    expect(() => listChatBookmarks(owner.id, { limit: 101 }, options)).toThrow(ChatBookmarkError);
    expect(() => listChatBookmarks(owner.id, { cursor: "bogus" }, options)).toThrow(
      ChatBookmarkError,
    );
  });
});
