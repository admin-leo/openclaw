import { DatabaseSync } from "node:sqlite";
import { expect, it, vi } from "vitest";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import {
  createPluginRegistryResourceOwner,
  drainPluginRegistryResourceDisposals,
  registerPluginRegistryResourceDisposer,
} from "../plugins/registry-resources.js";
import { withPluginRuntimeRegistryScope } from "../plugins/runtime/gateway-request-scope.js";
import { createPluginRuntime } from "../plugins/runtime/index.js";
import { createDeferredCore } from "../shared/deferred.js";
import type {
  RealtimeVoiceBridge,
  RealtimeVoiceBridgeCreateRequest,
} from "../talk/provider-types.js";
import { startMeetingAgentRealtimeEngine } from "./realtime-agent-engine.js";
import type { MeetingRealtimeAudioTransport } from "./realtime-audio-transport.js";
import {
  startMeetingRealtimeEngine,
  type MeetingRealtimeAudioEngineHandle,
  type MeetingRealtimeToolCallParams,
} from "./realtime-engine.js";

function createFixture(
  kind: "voice" | "agent",
  connect: () => Promise<void> = async () => {},
  options: {
    createVoiceBridge?: (request: RealtimeVoiceBridgeCreateRequest) => RealtimeVoiceBridge;
    handleToolCall?: (params: MeetingRealtimeToolCallParams) => Promise<void>;
    onCleanupReady?: (stop: () => Promise<void>) => void | Promise<void>;
  } = {},
) {
  const db = new DatabaseSync(":memory:");
  db.exec("CREATE TABLE native_state (value TEXT); INSERT INTO native_state VALUES ('retained')");
  const registry = createEmptyPluginRegistry();
  const close = vi.fn(() => {});
  const createProvider = vi.fn();
  const disposeNative = vi.fn(() => db.close());
  const owner = createPluginRegistryResourceOwner(registry, "scoped");
  registerPluginRegistryResourceDisposer(registry, "meeting-native", {
    id: "meeting-native-db",
    dispose: disposeNative,
  });
  registry.realtimeVoiceProviders.push({
    pluginId: "meeting-native",
    source: "synthetic-native-fixture",
    provider: {
      id: "meeting-native",
      label: "Meeting native",
      isConfigured: () => true,
      createBridge: (request) => {
        createProvider();
        return options.createVoiceBridge
          ? options.createVoiceBridge(request)
          : {
              connect,
              close,
              sendAudio() {},
              setMediaTimestamp() {},
              acknowledgeMark() {},
              submitToolResult() {},
              isConnected: () => true,
            };
      },
    },
  });
  registry.realtimeTranscriptionProviders.push({
    pluginId: "meeting-native",
    source: "synthetic-native-fixture",
    provider: {
      id: "meeting-native",
      label: "Meeting native",
      isConfigured: () => true,
      createSession: () => {
        createProvider();
        return { connect, close, sendAudio() {}, isConnected: () => true };
      },
    },
  });
  let onFatal: (() => void) | undefined;
  const stop = vi.fn(async () => {});
  const dispose = vi.fn(async () => {});
  const transport: MeetingRealtimeAudioTransport = {
    stop,
    dispose,
    onFatal(handler) {
      onFatal = handler;
    },
    startInput() {},
    async writeOutput() {},
    async clearOutput() {},
  };
  const params = {
    config: {
      chrome: { audioFormat: "pcm16-24khz" as const },
      realtime: {
        strategy: "bidi",
        provider: "meeting-native",
        providers: { "meeting-native": {} },
      },
    },
    fullConfig: {},
    runtime: createPluginRuntime(),
    platform: {
      displayName: "Meeting fixture",
      logScope: "meeting-fixture",
      sessionIdPrefix: "meeting-fixture",
    },
    meetingSessionId: "meeting-native",
    transport,
    logger: { info() {}, warn() {}, debug() {}, error() {} },
    consultAgent: async () => ({ text: "unused" }),
    onCleanupReady: options.onCleanupReady,
  };
  return {
    db,
    owner,
    close,
    createProvider,
    disposeNative,
    stop,
    dispose,
    fatal() {
      onFatal?.();
    },
    start: () =>
      withPluginRuntimeRegistryScope(registry, () =>
        kind === "agent"
          ? startMeetingAgentRealtimeEngine(params)
          : startMeetingRealtimeEngine({
              ...params,
              tools: [],
              handleToolCall: options.handleToolCall ?? (async () => {}),
            }),
      ),
  };
}

it.each(["voice", "agent"] as const)(
  "awaits %s cleanup ownership before constructing the provider",
  async (kind) => {
    const entered = createDeferredCore();
    const finish = createDeferredCore();
    let cleanup: (() => Promise<void>) | undefined;
    const fixture = createFixture(kind, undefined, {
      onCleanupReady: async (stop) => {
        cleanup = stop;
        entered.resolve();
        await finish.promise;
      },
    });
    const starting = fixture.start();
    try {
      await entered.promise;
      fixture.owner.release();
      expect(fixture.createProvider).not.toHaveBeenCalled();
      expect(fixture.db.isOpen).toBe(true);
      finish.resolve();
      const handle = await starting;
      expect(handle.stop).toBe(cleanup);
      expect(fixture.createProvider).toHaveBeenCalledOnce();
      await handle.stop();
      await drainPluginRegistryResourceDisposals();
      expect(fixture.db.isOpen).toBe(false);
    } finally {
      finish.resolve();
      await starting.catch(() => {});
      await cleanup?.().catch(() => {});
      fixture.owner.release();
      await drainPluginRegistryResourceDisposals();
      if (fixture.db.isOpen) {
        fixture.db.close();
      }
    }
  },
);

it.each(["voice", "agent"] as const)(
  "does not construct a %s provider when cleanup registration stops the engine",
  async (kind) => {
    const fixture = createFixture(kind, undefined, { onCleanupReady: (stop) => stop() });
    try {
      const starting = fixture.start();
      fixture.owner.release();
      await expect(starting).rejects.toThrow("stopped before");
      expect(fixture.createProvider).not.toHaveBeenCalled();
      await drainPluginRegistryResourceDisposals();
      expect(fixture.db.isOpen).toBe(false);
    } finally {
      fixture.owner.release();
      await drainPluginRegistryResourceDisposals();
      if (fixture.db.isOpen) {
        fixture.db.close();
      }
    }
  },
);

it.each(["voice", "agent"] as const)(
  "retains %s failed-start native resources until the error cleanup owner succeeds",
  async (kind) => {
    const startupError = new Error("provider connect failed");
    const cleanupError = new Error("provider close failed");
    const fixture = createFixture(kind, async () => {
      throw startupError;
    });
    let allowClose = false;
    let cleanup: Pick<MeetingRealtimeAudioEngineHandle, "stop"> | undefined;
    fixture.close.mockImplementation(() => {
      expect(fixture.db.prepare("SELECT value FROM native_state").get()?.value).toBe("retained");
      if (!allowClose) {
        throw cleanupError;
      }
    });

    try {
      const starting = fixture.start();
      fixture.owner.release();
      const failure: Error & {
        cleanup?: Pick<MeetingRealtimeAudioEngineHandle, "stop">;
        cleanupError?: unknown;
      } = await starting.then(
        () => {
          throw new Error("Provider startup unexpectedly succeeded");
        },
        (error: unknown) => {
          if (!(error instanceof Error)) {
            throw error;
          }
          return error;
        },
      );
      cleanup = failure.cleanup;
      await drainPluginRegistryResourceDisposals();
      expect(fixture.db.isOpen).toBe(true);
      expect(fixture.disposeNative).not.toHaveBeenCalled();
      expect(fixture.close).toHaveBeenCalledTimes(kind === "voice" ? 2 : 1);
      expect(failure.name).toBe("MeetingRealtimeStartupCleanupError");
      expect(failure.cause).toBe(startupError);
      expect(failure.cleanupError).toBe(cleanupError);
      expect(cleanup).toEqual({ stop: expect.any(Function) });
      if (!cleanup) {
        throw new Error("Failed startup did not expose its cleanup owner");
      }

      allowClose = true;
      await cleanup.stop();
      await drainPluginRegistryResourceDisposals();
      expect(fixture.db.isOpen).toBe(false);
      expect(fixture.disposeNative).toHaveBeenCalledOnce();
      await cleanup.stop();
      expect(fixture.disposeNative).toHaveBeenCalledOnce();
    } finally {
      allowClose = true;
      await cleanup?.stop().catch(() => {});
      fixture.owner.release();
      await drainPluginRegistryResourceDisposals();
      if (fixture.db.isOpen) {
        fixture.db.close();
      }
    }
  },
);

it.each(["voice", "agent"] as const)(
  "preserves the original %s startup error when rollback succeeds",
  async (kind) => {
    const startupError = new Error("provider connect failed");
    const fixture = createFixture(kind, async () => {
      throw startupError;
    });
    try {
      const starting = fixture.start();
      fixture.owner.release();
      await expect(starting).rejects.toBe(startupError);
      await drainPluginRegistryResourceDisposals();
      expect(fixture.db.isOpen).toBe(false);
      expect(fixture.close).toHaveBeenCalledOnce();
      expect(fixture.disposeNative).toHaveBeenCalledOnce();
    } finally {
      fixture.owner.release();
      await drainPluginRegistryResourceDisposals();
      if (fixture.db.isOpen) {
        fixture.db.close();
      }
    }
  },
);

it.each([
  { kind: "voice", failure: "close" },
  { kind: "voice", failure: "stop" },
  { kind: "voice", failure: "dispose" },
  { kind: "agent", failure: "stop" },
  { kind: "agent", failure: "dispose" },
  { kind: "agent", failure: "close" },
] as const)(
  "retains $kind native resources after rejected $failure until cleanup retry succeeds",
  async ({ kind, failure }) => {
    const fixture = createFixture(kind);
    let handle: MeetingRealtimeAudioEngineHandle | undefined;
    try {
      handle = await fixture.start();
      fixture.owner.release();
      if (failure === "close") {
        fixture.close.mockImplementationOnce(() => {
          throw new Error("cleanup failed");
        });
      } else {
        fixture[failure].mockRejectedValueOnce(new Error("cleanup failed"));
      }
      await expect(handle.stop()).rejects.toThrow("cleanup failed");
      expect(fixture.db.prepare("SELECT value FROM native_state").get()?.value).toBe("retained");
      await expect(handle.stop()).resolves.toBeUndefined();
      if (failure === "close") {
        expect(fixture.close).toHaveBeenCalledTimes(2);
      }
      await drainPluginRegistryResourceDisposals();
      expect(fixture.db.isOpen).toBe(false);
    } finally {
      await handle?.stop().catch(() => {});
      fixture.owner.release();
      await drainPluginRegistryResourceDisposals();
      if (fixture.db.isOpen) {
        fixture.db.close();
      }
    }
  },
);

it.each(["voice", "agent"] as const)(
  "keeps %s native resources through connect finishing after fatal cleanup",
  async (kind) => {
    const entered = createDeferredCore();
    const finish = createDeferredCore();
    const fixture = createFixture(kind, async () => {
      entered.resolve();
      await finish.promise;
      expect(fixture.db.prepare("SELECT value FROM native_state").get()?.value).toBe("retained");
    });

    const starting = fixture.start();
    const startResult = starting.catch((error: unknown) => error);
    try {
      await entered.promise;
      fixture.owner.release();
      fixture.fatal();
      await vi.waitFor(() => expect(fixture.dispose).toHaveBeenCalledOnce());
      expect(fixture.db.isOpen).toBe(true);
      finish.resolve();
      await expect(startResult).resolves.toMatchObject({
        message: expect.stringMatching(/stopped during/),
      });
      await drainPluginRegistryResourceDisposals();
      expect(fixture.db.isOpen).toBe(false);
    } finally {
      finish.resolve();
      await startResult;
      fixture.owner.release();
      await drainPluginRegistryResourceDisposals();
      if (fixture.db.isOpen) {
        fixture.db.close();
      }
    }
  },
);

it("retains an accepted provider submission after startup and transport cleanup reject", async () => {
  const entered = createDeferredCore();
  const finish = createDeferredCore();
  const submitted = createDeferredCore<unknown>();
  const submissionResult = submitted.promise.catch((error: unknown) => error);
  let cleanup: (() => Promise<void>) | undefined;
  const fixture = createFixture("voice", undefined, {
    onCleanupReady: (stop) => {
      cleanup = stop;
    },
    createVoiceBridge: (request) => ({
      connect: async () => {
        request.onToolCall?.({ itemId: "item", callId: "call", name: "synthetic", args: {} });
        await entered.promise;
        throw new Error("connect failed");
      },
      close() {},
      sendAudio() {},
      setMediaTimestamp() {},
      acknowledgeMark() {},
      isConnected: () => true,
      submitToolResult: async () => {
        entered.resolve();
        await finish.promise;
        try {
          submitted.resolve(fixture.db.prepare("SELECT value FROM native_state").get()?.value);
        } catch (error) {
          submitted.reject(error);
          throw error;
        }
      },
    }),
    handleToolCall: async ({ session, event }) => {
      await session.submitToolResult(event.callId, { text: "accepted before close" });
    },
  });
  fixture.stop.mockRejectedValue(new Error("transport stop failed"));
  fixture.dispose.mockRejectedValue(new Error("transport dispose failed"));
  const starting = fixture.start();
  try {
    await entered.promise;
    fixture.owner.release();
    await expect(starting).rejects.toThrow("connect failed");
    expect(fixture.db.isOpen).toBe(true);
    finish.resolve();
    await expect(submissionResult).resolves.toBe("retained");
    fixture.stop.mockResolvedValue();
    fixture.dispose.mockResolvedValue();
    await cleanup?.();
    await drainPluginRegistryResourceDisposals();
    expect(fixture.db.isOpen).toBe(false);
  } finally {
    finish.resolve();
    await starting.catch(() => {});
    await submissionResult;
    fixture.stop.mockResolvedValue();
    fixture.dispose.mockResolvedValue();
    await cleanup?.().catch(() => {});
    fixture.owner.release();
    await drainPluginRegistryResourceDisposals();
    if (fixture.db.isOpen) {
      fixture.db.close();
    }
  }
});
