/* @vitest-environment jsdom */
import { render } from "lit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatBookmark } from "../../../../../packages/gateway-protocol/src/index.js";
import type { MessageGroup } from "../../../lib/chat/chat-types.ts";
import { coalesceAgentRunFrames } from "../chat-agent-run-grouping.ts";
import type { ChatBookmarkAccess } from "../chat-bookmarks.ts";
import { createTestTranscript } from "../chat-view.test-helpers.ts";
import { renderAgentRunFrame } from "./chat-agent-run-frame.ts";
import { renderMessageGroup } from "./chat-message-group.ts";
import {
  renderMessageActionButtons,
  resolveMessageActionDetails,
} from "./chat-message-markdown.ts";
import { getTranscriptState } from "./chat-thread-interactions.ts";
import { renderChatThread } from "./chat-thread.ts";
import {
  flushDeferredRowPrune,
  installTranscriptDomMocks,
  resetTranscriptTestDom,
  threadProps,
} from "./chat-transcript.test-support.ts";

function saved(messageId = "source", name = "Decision"): ChatBookmark {
  return {
    id: "bookmark-" + messageId,
    agentId: "main",
    sessionKey: "agent:main:main",
    sessionId: "generation",
    messageId,
    name,
    createdAt: 1,
    updatedAt: 1,
  };
}
function access(): ChatBookmarkAccess {
  return {
    revision: 0,
    bookmarks: [],
    selectedId: null,
    revealId: null,
    edit: vi.fn(),
    toggle: vi.fn(),
    open: vi.fn(),
  };
}
function message(id: string, role = "assistant", text = id) {
  return { role, content: text, timestamp: 1000, __openclaw: { id } };
}
function group(id: string, role: "assistant" | "user" = "assistant"): MessageGroup {
  return {
    kind: "group",
    key: "group-" + id,
    role,
    visibleContent: "text",
    timestamp: 1000,
    isStreaming: false,
    runId: "run",
    messages: [{ key: "render-" + id, message: message(id, role) }],
  };
}
const renderOptions = {
  showReasoning: false,
  showToolCalls: true,
  assistantName: "Assistant",
  assistantAvatar: null,
};

describe("bookmark source actions", () => {
  beforeEach(installTranscriptDomMocks);
  afterEach(resetTranscriptTestDom);

  it.each(["user", "assistant", "toolResult"])(
    "bookmarks a persisted %s without Reply permission and never uses its render key",
    (role) => {
      const bookmarkAccess = access();
      const details = resolveMessageActionDetails({
        message: message("source", role),
        messageId: "render-key",
        senderLabel: "Sender",
        bookmarkAccess,
      });
      expect(details).not.toBeNull();
      const container = document.body.appendChild(document.createElement("div"));
      render(renderMessageActionButtons(details!, { bookmarkAccess }), container);
      container.querySelector<HTMLButtonElement>(".chat-bookmark-btn")!.click();
      expect(bookmarkAccess.toggle).toHaveBeenCalledWith("source");
      expect(container.querySelector('[aria-label="Reply to message"]')).toBeNull();
    },
  );

  it("places the unchanged claw immediately before Reply, with the saved name after the actions", () => {
    const bookmarkAccess = access();
    bookmarkAccess.bookmarks = [saved()];
    const onReply = vi.fn();
    const details = resolveMessageActionDetails({
      message: message("source"),
      messageId: "render-key",
      senderLabel: "Sender",
      bookmarkAccess,
      onReply,
    })!;
    const container = document.body.appendChild(document.createElement("div"));
    render(renderMessageActionButtons(details, { bookmarkAccess, onReply }), container);
    const buttons = [...container.querySelectorAll<HTMLButtonElement>("button")];
    expect(buttons[0]?.classList.contains("chat-bookmark-btn")).toBe(true);
    expect(buttons[1]?.getAttribute("aria-label")).toBe("Reply to message");
    expect(buttons[0]?.getAttribute("aria-pressed")).toBe("true");
    expect(buttons.at(-1)?.textContent).toContain("Decision");
    buttons[0]!.click();
    expect(bookmarkAccess.toggle).toHaveBeenCalledWith("source");
    expect(bookmarkAccess.edit).not.toHaveBeenCalled();
    buttons.at(-1)!.click();
    expect(bookmarkAccess.edit).toHaveBeenCalledWith("source");
  });

  it.each([
    { role: "user", content: "Not persisted" },
    { role: "assistant", content: "Stream", __openclaw: { id: "pending:test" } },
    { ...message("mirror"), openclawMessageToolMirror: true },
  ])("does not bookmark ineligible input $content", (source) => {
    const details = resolveMessageActionDetails({
      message: source,
      messageId: "render-only",
      senderLabel: "Sender",
      bookmarkAccess: access(),
    });
    expect(details?.bookmark).toBeUndefined();
  });

  it("gives earlier grouped sources their own action and the footer to the last source", () => {
    const bookmarkAccess = access();
    const combined = group("first", "user");
    combined.messages.push({ key: "render-second", message: message("second", "user") });
    const container = document.body.appendChild(document.createElement("div"));
    render(renderMessageGroup(combined, { ...renderOptions, bookmarkAccess }), container);
    const buttons = container.querySelectorAll<HTMLButtonElement>(".chat-bookmark-btn");
    expect(buttons).toHaveLength(2);
    buttons[0]!.click();
    buttons[1]!.click();
    expect(bookmarkAccess.toggle).toHaveBeenNthCalledWith(1, "first");
    expect(bookmarkAccess.toggle).toHaveBeenNthCalledWith(2, "second");
  });

  it("uses the completed frame's actual action owner, not its representative, without duplicate actions", () => {
    const bookmarkAccess = access();
    const frames = coalesceAgentRunFrames([group("user", "user"), group("early"), group("final")], {
      searchActive: false,
    });
    const frame = frames.find((item) => item.kind === "agent-run-frame");
    expect(frame?.kind).toBe("agent-run-frame");
    if (!frame || frame.kind !== "agent-run-frame") {
      throw new Error("Expected completed frame");
    }
    const container = document.body.appendChild(document.createElement("div"));
    render(
      renderAgentRunFrame(frame, {
        streamOptions: {},
        renderGroupOptions: () => ({ ...renderOptions, bookmarkAccess }),
        isWorkExpanded: () => true,
        onToggleWork: vi.fn(),
      }),
      container,
    );
    const buttons = container.querySelectorAll<HTMLButtonElement>(".chat-bookmark-btn");
    expect(buttons).toHaveLength(2);
    container.querySelector<HTMLButtonElement>(".chat-group-footer .chat-bookmark-btn")!.click();
    expect(bookmarkAccess.toggle).toHaveBeenLastCalledWith("final");
    container
      .querySelector<HTMLButtonElement>(
        '[data-message-actions-for="render-early"] .chat-bookmark-btn',
      )!
      .click();
    expect(bookmarkAccess.toggle).toHaveBeenLastCalledWith("early");
  });

  it("invalidates guarded source rows on rename and reveals a filtered source as a real bubble", async () => {
    const bookmarkAccess = access();
    const props = {
      ...threadProps("bookmark-render", "agent:main:main", [
        message("source", "assistant", "Original answer"),
        message("later", "user", "Later question"),
      ]),
      bookmarkAccess,
    };
    const transcript = createTestTranscript();
    const container = document.body.appendChild(document.createElement("div"));
    const draw = () => {
      render(renderChatThread(props, transcript), container);
      transcript.hostUpdated();
    };
    draw();
    transcript.hostConnected();
    await flushDeferredRowPrune();
    bookmarkAccess.bookmarks = [saved("source", "Renamed decision")];
    bookmarkAccess.revision++;
    draw();
    expect(container.querySelector(".chat-bookmark-name")?.textContent).toContain(
      "Renamed decision",
    );
    const state = getTranscriptState(props.paneId);
    state.searchOpen = true;
    state.searchQuery = "Later";
    draw();
    await flushDeferredRowPrune();
    expect(container.querySelector('[data-entry-id="source"]')).toBeNull();
    bookmarkAccess.revealId = "source";
    bookmarkAccess.revision++;
    draw();
    await flushDeferredRowPrune();
    const bubble = container.querySelector('[data-entry-id="source"]');
    expect(bubble?.textContent).toContain("Original answer");
    expect(state.searchOpen).toBe(false);
    const revealed = vi.fn();
    expect(
      transcript.revealMessage("source", { isCurrent: () => true, onRevealed: revealed }),
    ).toBe(true);
    await Promise.resolve();
    expect(revealed).toHaveBeenCalledWith(true);
    transcript.hostDisconnected();
  });
});
