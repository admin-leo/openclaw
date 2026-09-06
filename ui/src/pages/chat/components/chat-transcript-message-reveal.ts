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
