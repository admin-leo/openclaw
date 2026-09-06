import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  appendTranscriptMessage,
  patchSessionEntryCore,
  resetSessionEntryLifecycle,
  upsertSessionEntryCore,
} from "../../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { listChatBookmarks } from "../../state/chat-bookmarks.js";
import { ensureProfileForEmail } from "../../state/user-profiles.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { authorizeOperatorScopesForMethod } from "../method-scopes.js";
import { createDirectChatContext } from "../server-chat.agent-events.test-helpers.js";
import { loadGatewaySessionEntryReadOnly } from "../session-utils.js";
import { chatBookmarkHandlers } from "./chat-bookmarks.js";
import * as historyPages from "./chat-history-pages.js";
import { identifiedClient } from "./sessions-read-cache.test-support.js";
import type { GatewayRequestHandlerOptions, RespondFn } from "./types.js";

const scope = {
  agentId: "main",
  sessionKey: "agent:main:bookmark-test",
  sessionId: "bookmark-generation-1",
};
const createParams = {
  key: scope.sessionKey,
  sessionId: scope.sessionId,
  messageId: "answer",
  name: "My answer",
};
afterEach(() => vi.restoreAllMocks());

async function fixture(authority: (() => boolean) | null = () => true) {
  const owner = ensureProfileForEmail("bookmark-owner@example.test");
  const other = ensureProfileForEmail("bookmark-other@example.test");
  const client = { ...identifiedClient(owner.id), connId: "owner-connection" };
  const second = { ...identifiedClient(owner.id), connId: "owner-second" };
  const outsider = { ...identifiedClient(other.id), connId: "other-connection" };
  const clients = [client, second, outsider];
  const context = createDirectChatContext({
    getClientConnIds: (filter) =>
      new Set(clients.filter((c) => !filter || filter(c)).map((c) => c.connId)),
  });
  await upsertSessionEntryCore(scope, { sessionId: scope.sessionId, updatedAt: 1 });
  await appendTranscriptMessage(scope, {
    eventId: "answer",
    message: { role: "assistant", content: [{ type: "text", text: "Private transcript body" }] },
  });
  const call = async (
    method: string,
    params: Record<string, unknown>,
    selectedClient: GatewayRequestHandlerOptions["client"] = client,
  ) => {
    const respond = vi.fn<RespondFn>();
    await expectDefined(
      chatBookmarkHandlers[method],
      "bookmark handler",
    )({
      req: { type: "req", id: "bookmark-request", method },
      params,
      context,
      client: selectedClient,
      respond,
      isWebchatConnect: () => false,
      ...(authority ? { hasCurrentClientAuthority: authority } : {}),
    });
    return respond;
  };
  return { owner, other, client, outsider, context, call };
}

describe("chat bookmark RPCs", () => {
  it.each(["revoked", "missing"])(
    "does not commit bookmark creation with %s client authority",
    async (mode) => {
      await withOpenClawTestState({ scenario: "minimal" }, async () => {
        let authorized = true;
        const f = await fixture(mode === "missing" ? null : () => authorized);
        const read = historyPages.readChatHistoryPage;
        vi.spyOn(historyPages, "readChatHistoryPage").mockImplementationOnce(async (params) => {
          const result = await read(params);
          authorized = false;
          return result;
        });
        const response = await f.call("chat.bookmarks.create", createParams);
        expect(response).toHaveBeenCalledWith(
          false,
          undefined,
          expect.objectContaining({ code: "INVALID_REQUEST" }),
        );
        expect(listChatBookmarks(f.owner.id).bookmarks).toEqual([]);
      });
    },
  );

  it("keeps literal global bookmarks scoped to their selected agent and rejects ambiguous or conflicting routes", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const cfg = {
        session: { scope: "per-sender" },
        agents: { ownership: "explicit", entries: { ops: {}, research: {} } },
      } satisfies OpenClawConfig;
      await state.writeConfig(cfg);
      const owner = ensureProfileForEmail("global-bookmarks@example.test");
      const client = identifiedClient(owner.id);
      const context = createDirectChatContext({ getRuntimeConfig: () => cfg });
      const call = async (method: string, params: Record<string, unknown>) => {
        const respond = vi.fn<RespondFn>();
        await expectDefined(
          chatBookmarkHandlers[method],
          "bookmark handler",
        )({
          req: { type: "req", id: "global-bookmark", method },
          params,
          context,
          client,
          respond,
          isWebchatConnect: () => false,
          hasCurrentClientAuthority: () => true,
        });
        return respond;
      };
      for (const agentId of ["ops", "research"]) {
        const globalScope = { agentId, sessionKey: "global", sessionId: "global-" + agentId };
        await upsertSessionEntryCore(globalScope, {
          sessionId: globalScope.sessionId,
          updatedAt: 1,
        });
        await appendTranscriptMessage(globalScope, {
          eventId: "answer",
          message: { role: "user", content: "An answer" },
        });
        expect(
          await call("chat.bookmarks.create", {
            key: "global",
            agentId,
            sessionId: globalScope.sessionId,
            messageId: "answer",
            name: agentId,
          }),
        ).toHaveBeenCalledWith(true, {
          bookmark: expect.objectContaining({ agentId, sessionKey: "global", name: agentId }),
        });
      }
      expect(listChatBookmarks(owner.id).bookmarks).toHaveLength(2);
      expect(
        await call("chat.bookmarks.list", { key: "global", agentId: "research" }),
      ).toHaveBeenCalledWith(true, {
        bookmarks: [expect.objectContaining({ agentId: "research" })],
      });
      expect(await call("chat.bookmarks.list", { agentId: "ops" })).toHaveBeenCalledWith(true, {
        bookmarks: [expect.objectContaining({ agentId: "ops" })],
      });
      for (const params of [
        { key: "global" },
        { key: "agent:ops:main", agentId: "research" },
        { key: "global", agentId: "absent" },
      ]) {
        expect(await call("chat.bookmarks.list", params)).toHaveBeenCalledWith(
          false,
          undefined,
          expect.objectContaining({ code: "INVALID_REQUEST" }),
        );
        expect(
          await call("chat.bookmarks.create", {
            ...params,
            sessionId: "global-ops",
            messageId: "answer",
            name: "Must not save",
          }),
        ).toHaveBeenCalledWith(
          false,
          undefined,
          expect.objectContaining({ code: "INVALID_REQUEST" }),
        );
      }
      expect(listChatBookmarks(owner.id).bookmarks).toHaveLength(2);
    });
  });
  it("uses existing read/write scopes", () => {
    expect(authorizeOperatorScopesForMethod("chat.bookmarks.list", ["operator.read"])).toEqual({
      allowed: true,
    });
    for (const method of [
      "chat.bookmarks.create",
      "chat.bookmarks.rename",
      "chat.bookmarks.remove",
    ]) {
      expect(authorizeOperatorScopesForMethod(method, ["operator.read"])).toEqual({
        allowed: false,
        missingScope: "operator.write",
      });
      expect(authorizeOperatorScopesForMethod(method, ["operator.write"])).toEqual({
        allowed: true,
      });
    }
  });

  it("writes only references for the current profile without broadcasting private metadata", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const f = await fixture();
      const response = await f.call("chat.bookmarks.create", createParams);
      const [bookmark] = listChatBookmarks(f.owner.id).bookmarks;
      expect(response).toHaveBeenCalledWith(true, { bookmark });
      expect(bookmark).toMatchObject({
        agentId: "main",
        sessionKey: scope.sessionKey,
        sessionId: scope.sessionId,
        messageId: "answer",
        name: "My answer",
      });
      expect(JSON.stringify(bookmark)).not.toContain("Private transcript body");
      expect(f.context.broadcastToConnIds).not.toHaveBeenCalled();
      expect(f.context.broadcast).not.toHaveBeenCalled();
      const others = await f.call("chat.bookmarks.list", {}, f.outsider);
      expect(others).toHaveBeenCalledWith(true, { bookmarks: [] });
      const spoof = await f.call("chat.bookmarks.create", {
        ...createParams,
        profileId: f.other.id,
      });
      expect(spoof).toHaveBeenCalledWith(
        false,
        undefined,
        expect.objectContaining({ code: "INVALID_REQUEST" }),
      );
      const anonymous = await f.call("chat.bookmarks.list", {}, null);
      expect(anonymous).toHaveBeenCalledWith(
        false,
        undefined,
        expect.objectContaining({ code: "UNAVAILABLE" }),
      );
    });
  });

  it("rejects pending, missing, noncanonical, catalog and stale-generation references, including hidden/incognito sources", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const f = await fixture();
      for (const params of [
        { messageId: "pending:input" },
        { messageId: "absent" },
        { key: "bookmark-test" },
        { key: "catalog:main:example" },
        { sessionId: "old-generation" },
      ]) {
        const response = await f.call("chat.bookmarks.create", { ...createParams, ...params });
        expect(response).toHaveBeenCalledWith(
          false,
          undefined,
          expect.objectContaining({ code: "INVALID_REQUEST" }),
        );
      }
      await patchSessionEntryCore(scope, () => ({ visibility: "draft" }));
      expect(await f.call("chat.bookmarks.create", createParams)).toHaveBeenCalledWith(
        false,
        undefined,
        expect.objectContaining({ code: "INVALID_REQUEST" }),
      );
      await patchSessionEntryCore(scope, () => ({ visibility: "shared", incognito: true }));
      expect(await f.call("chat.bookmarks.create", createParams)).toHaveBeenCalledWith(
        false,
        undefined,
        expect.objectContaining({ code: "INVALID_REQUEST" }),
      );
      expect(listChatBookmarks(f.owner.id).bookmarks).toEqual([]);
    });
  });

  it("revalidates source generation after the history read and keeps older bookmarks removable after reset", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const f = await fixture();
      await f.call("chat.bookmarks.create", createParams);
      const bookmark = expectDefined(
        listChatBookmarks(f.owner.id).bookmarks[0],
        "created bookmark",
      );
      const read = historyPages.readChatHistoryPage;
      vi.spyOn(historyPages, "readChatHistoryPage").mockImplementationOnce(async (params) => {
        const result = await read(params);
        await resetSessionEntryLifecycle({
          agentId: scope.agentId,
          storePath: loadGatewaySessionEntryReadOnly(scope.sessionKey).storePath,
          target: { canonicalKey: scope.sessionKey, storeKeys: [scope.sessionKey] },
          resetBoundary: { context: "clear", reason: "new", cwd: "/bookmark-test" },
          buildNextEntry: () => ({
            sessionId: scope.sessionId,
            updatedAt: 2,
            sessionStartedAt: 2,
            lifecycleRevision: "reset-revision",
          }),
        });
        return result;
      });
      expect(
        await f.call("chat.bookmarks.create", { ...createParams, name: "Must not replace" }),
      ).toHaveBeenCalledWith(
        false,
        undefined,
        expect.objectContaining({ code: "INVALID_REQUEST" }),
      );
      expect(listChatBookmarks(f.owner.id).bookmarks).toEqual([bookmark]);
      expect(
        await f.call("chat.bookmarks.rename", { bookmarkId: bookmark.id, name: "Old answer" }),
      ).toHaveBeenCalledWith(true, {
        bookmark: expect.objectContaining({ sessionId: scope.sessionId, name: "Old answer" }),
      });
      expect(
        await f.call("chat.bookmarks.remove", { bookmarkId: bookmark.id }),
      ).toHaveBeenCalledWith(true, { ok: true });
      expect(listChatBookmarks(f.owner.id).bookmarks).toEqual([]);
    });
  });
});
