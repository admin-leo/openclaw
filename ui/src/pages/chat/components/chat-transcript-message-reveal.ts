import type { LoadedReplySource, MessageGroup } from "../../../lib/chat/chat-types.ts";
import type { coalesceAgentRunFrames } from "../chat-agent-run-grouping.ts";
import { persistedMessageEntryId } from "../chat-thread-items.ts";

export function groupHasRevealedSource(
  group: MessageGroup,
  messageId: string | null | undefined,
): boolean {
  return Boolean(
    messageId && group.messages.some((item) => persistedMessageEntryId(item.message) === messageId),
  );
}

/** Keep hidden activity private except for the exact explicitly requested source. */
export function visibleActivityGroups(
  groups: readonly MessageGroup[],
  showTools: boolean | undefined,
  messageId: string | null | undefined,
): readonly MessageGroup[] {
  if (showTools !== false) {
    return groups;
  }
  if (!messageId) {
    return [];
  }
  return groups.flatMap((group) => {
    const messages = group.messages.filter(
      (item) => persistedMessageEntryId(item.message) === messageId,
    );
    return messages.length ? [{ ...group, messages }] : [];
  });
}

/** Only the disclosure containing the requested source needs to open. */
export function revealedWorkGroupKeys(
  items: ReturnType<typeof coalesceAgentRunFrames>,
  messageId: string | null | undefined,
): ReadonlySet<string> {
  const keys = new Set<string>();
  if (!messageId) {
    return keys;
  }
  for (const item of items) {
    for (const part of item.kind === "agent-run-frame" ? item.parts : [item]) {
      if (
        part.kind === "work-group" &&
        part.groups.some((group) => groupHasRevealedSource(group, messageId))
      ) {
        keys.add(part.key);
      }
    }
  }
  return keys;
}

/** Applies a committed source reveal; scroll-command ownership stays with the virtualizer. */
export function revealTranscriptMessageBubble(
  inner: HTMLElement | null,
  messageId: string,
  behavior: ScrollBehavior,
  onRevealed?: (visible: boolean) => void,
): void {
  const bubble = [...(inner?.querySelectorAll<HTMLElement>(".chat-bubble") ?? [])].find(
    (candidate) => candidate.dataset.entryId === messageId,
  );
  if (!bubble || bubble.closest("[hidden]")) {
    onRevealed?.(false);
    return;
  }
  onRevealed?.(true);
  inner?.querySelector(".chat-bubble--reply-target")?.classList.remove("chat-bubble--reply-target");
  bubble.scrollIntoView?.({ behavior, block: "center" });
  bubble.classList.add("chat-bubble--reply-target");
  bubble.addEventListener(
    "animationend",
    () => bubble.classList.remove("chat-bubble--reply-target"),
    { once: true },
  );
}

/** Index the same canonical source for both navigation and reply hydration. */
export function indexTranscriptSources(params: {
  groups: readonly MessageGroup[];
  rowKeyForGroup: (group: MessageGroup) => string;
  senderLabel: string;
  messageRowKeysById: Map<string, string>;
  loadedReplySources: Map<string, LoadedReplySource>;
}): void {
  for (const group of params.groups) {
    const rowKey = params.rowKeyForGroup(group);
    for (const source of group.messages) {
      const sourceMessageId = persistedMessageEntryId(source.message);
      if (sourceMessageId) {
        params.messageRowKeysById.set(sourceMessageId, rowKey);
        params.loadedReplySources.set(sourceMessageId, {
          message: source.message,
          messageId: source.key,
          senderLabel: params.senderLabel,
        });
      }
    }
  }
}
