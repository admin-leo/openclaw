import { describe, expect, it } from "vitest";
import {
  validateChatBookmarksCreateParams,
  validateChatBookmarksListParams,
  validateChatBookmarksRenameParams,
} from "./index.js";

const create = {
  key: "agent:main:main",
  sessionId: "generation-1",
  messageId: "message-1",
  name: "A useful answer",
};

describe("chat bookmark wire contract", () => {
  it("rejects caller-chosen ownership and transcript payloads", () => {
    expect(validateChatBookmarksCreateParams(create)).toBe(true);
    expect(validateChatBookmarksCreateParams({ ...create, profileId: "other" })).toBe(false);
    expect(validateChatBookmarksCreateParams({ ...create, text: "transcript body" })).toBe(false);
    expect(validateChatBookmarksCreateParams({ ...create, sessionId: undefined })).toBe(false);
  });

  it("bounds Unicode names and list requests", () => {
    expect(validateChatBookmarksCreateParams({ ...create, name: "🦞".repeat(70) })).toBe(true);
    expect(
      validateChatBookmarksRenameParams({ bookmarkId: "bookmark-1", name: "🦞".repeat(71) }),
    ).toBe(false);
    expect(validateChatBookmarksRenameParams({ bookmarkId: "bookmark-1", name: "   " })).toBe(
      false,
    );
    expect(validateChatBookmarksListParams({ limit: 100 })).toBe(true);
    for (const limit of [0, 101, 1.5]) {
      expect(validateChatBookmarksListParams({ limit })).toBe(false);
    }
    expect(validateChatBookmarksListParams({ cursor: "x".repeat(513) })).toBe(false);
  });
});
