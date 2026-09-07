import type { AgentMessage } from "openclaw/plugin-sdk/agent-harness-runtime";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { CodexTranscriptCheckpoint } from "./transcript-checkpoint.js";
import { attachCodexMirrorIdentity, readMirrorIdentity } from "./upstream-prompt-provenance.js";

const providerCommit = vi.hoisted(() => vi.fn());
const mirror = vi.hoisted(() => vi.fn());

vi.mock("./provider-transcript-commit.js", () => ({
  commitProviderSessionTranscriptPrefix: providerCommit,
}));
vi.mock("./transcript-mirror.js", () => ({
  codexTranscriptMirrorRuntime: { mirror },
}));

function checkpoint() {
  return new CodexTranscriptCheckpoint(
    {
      hostCapabilities: { assertActive: () => undefined },
      runId: "run-1",
      sessionId: "session-1",
      sessionTarget: {
        agentId: "main",
        sessionId: "session-1",
        sessionKey: "agent:main:session-1",
        storePath: "/tmp/sessions.json",
      },
    } as never,
    "thread-1",
    "turn-1",
  );
}

function result(status: "completed" | "waiting"): AgentMessage {
  return attachCodexMirrorIdentity(
    {
      role: "toolResult",
      toolCallId: "call-1",
      toolName: "exec",
      content: [{ type: "text", text: status }],
      details: { status },
      isError: false,
    } as AgentMessage,
    `turn-1:tool:call-1:${status}`,
  );
}

beforeEach(() => {
  providerCommit.mockReset().mockResolvedValue({ kind: "committed", results: [] });
  mirror.mockReset().mockResolvedValue({
    anchorsByMirrorIdentity: new Map(),
    messagesPresent: [],
  });
});

describe("Codex waiting result durability", () => {
  it("uses commit authority only for a required waiting checkpoint", async () => {
    const waiting = checkpoint();
    const receipt = waiting.enqueue({ read: () => result("waiting"), requiredCommit: true });
    await waiting.flush();
    await expect(receipt).resolves.toBeUndefined();

    expect(providerCommit).toHaveBeenCalledOnce();
    expect(mirror).toHaveBeenCalledWith(expect.objectContaining({ inspectOnly: true }));
    const committed = providerCommit.mock.calls[0]?.[1].entries[0];
    expect(committed.eventId).toBe(committed.identity);
    expect(committed.message.idempotencyKey).toBe(committed.identity);

    const reopened = checkpoint();
    reopened.enqueue({ read: () => result("waiting") });
    await reopened.flush();
    const mirrored = mirror.mock.calls[1]?.[0];
    expect(`${mirrored.idempotencyScope}:${readMirrorIdentity(mirrored.messages[0])}`).toBe(
      committed.identity,
    );

    const terminal = checkpoint();
    terminal.enqueue({ read: () => result("completed") });
    await terminal.flush();

    expect(providerCommit).toHaveBeenCalledOnce();
    expect(mirror).toHaveBeenCalledTimes(3);
  });

  it("does not commit a required checkpoint abandoned while queued", async () => {
    let releaseCommit: (() => void) | undefined;
    const commitReleased = new Promise<void>((resolve) => {
      releaseCommit = resolve;
    });
    let commitEntered: (() => void) | undefined;
    const commitStarted = new Promise<void>((resolve) => {
      commitEntered = resolve;
    });
    let committed = false;
    providerCommit.mockImplementationOnce(
      async (_hostCapabilities: unknown, { assertCurrent }: { assertCurrent: () => void }) => {
        commitEntered?.();
        await commitReleased;
        assertCurrent();
        committed = true;
        return { kind: "committed", results: [] };
      },
    );
    const waiting = checkpoint();
    const receipt = waiting.enqueue({ read: () => result("waiting"), requiredCommit: true });
    const flushing = waiting.flush();
    await commitStarted;

    waiting.abandon();
    releaseCommit?.();

    await expect(flushing).rejects.toThrow("checkpoint was retired before write");
    await expect(receipt).rejects.toThrow("checkpoint was retired before write");
    expect(committed).toBe(false);
  });

  it("keeps the exact required receipt pending behind an earlier unready entry", async () => {
    const waiting = checkpoint();
    let earlierReady = false;
    waiting.enqueue({
      read: () => result("completed"),
      ready: () => earlierReady,
    });
    const receipt = waiting.enqueue({ read: () => result("waiting"), requiredCommit: true });
    let settled = false;
    void receipt?.finally(() => {
      settled = true;
    });

    await waiting.flush();
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(providerCommit).not.toHaveBeenCalled();

    earlierReady = true;
    await waiting.flush();
    await expect(receipt).resolves.toBeUndefined();
    expect(providerCommit).toHaveBeenCalledOnce();
  });

  it.each([
    {
      name: "commit failure",
      setup: () => providerCommit.mockRejectedValueOnce(new Error("write failed")),
      expected: "write failed",
    },
    {
      name: "commit conflict",
      setup: () => providerCommit.mockResolvedValueOnce({ kind: "conflict", reason: "drift" }),
      expected: "commit conflict",
    },
  ])("rejects the exact required receipt on $name", async ({ setup, expected }) => {
    setup();
    const waiting = checkpoint();
    const receipt = waiting.enqueue({ read: () => result("waiting"), requiredCommit: true });
    await expect(waiting.flush()).rejects.toThrow(expected);
    await expect(receipt).rejects.toThrow(expected);
  });

  it("rejects a required receipt enqueued after checkpoint close", async () => {
    const waiting = checkpoint();
    await waiting.flush(true);
    await expect(
      waiting.enqueue({ read: () => result("waiting"), requiredCommit: true }),
    ).rejects.toThrow("checkpoint is closed");
    expect(providerCommit).not.toHaveBeenCalled();
  });
});
