import {
  ErrorCodes,
  errorShape,
  validateChatBookmarksListParams,
  validateChatBookmarksCreateParams,
  validateChatBookmarksRenameParams,
  validateChatBookmarksRemoveParams,
  type ChatBookmarksCreateParams,
} from "../../../packages/gateway-protocol/src/index.js";
import { CHAT_PENDING_INPUT_MESSAGE_PREFIX } from "../../../packages/gateway-protocol/src/schema/chat-history-constants.js";
import { readSessionTranscriptHistoryAnchorPage } from "../../config/sessions/session-accessor.sqlite-history-events.js";
import { isIncognitoSessionKey } from "../../routing/session-key.js";
import {
  ChatBookmarkError,
  createChatBookmark,
  listChatBookmarks,
  renameChatBookmark,
  removeChatBookmark,
} from "../../state/chat-bookmarks.js";
import { resolveUserProfileId } from "../../state/user-profiles.js";
import { readChatHistoryMessageId } from "../session-history-tail.js";
import { resolveRequestedSessionAgentId } from "../session-request-agent.js";
import { createSessionListEntryFilter } from "../session-sharing.js";
import { loadGatewaySessionEntryReadOnly } from "../session-utils.js";
import { readChatHistoryPage } from "./chat-history-pages.js";
import { validateChatSelectedAgent } from "./chat-origin-routing.js";
import { authenticatedProfileUnavailableError } from "./gateway-client-identity.js";
import type { GatewayRequestHandlerOptions, GatewayRequestHandlers } from "./types.js";
import { assertValidParams } from "./validation.js";

type Request = Pick<GatewayRequestHandlerOptions, "client" | "context" | "respond">;

function requireProfile({ client, respond }: Request): string | undefined {
  const profileId = client?.authenticatedUserProfile?.profileId;
  const canonical = profileId ? resolveUserProfileId(profileId) : undefined;
  if (!canonical) {
    respond(false, undefined, authenticatedProfileUnavailableError());
  }
  return canonical;
}

function assertMutationAuthority(
  request: Pick<
    GatewayRequestHandlerOptions,
    "signal" | "hasCurrentClientAuthority" | "sessionMutationCommitGuard"
  >,
): void {
  if (request.signal?.aborted || !request.hasCurrentClientAuthority?.()) {
    throw new ChatBookmarkError(
      "Bookmark request is no longer authorized. Reconnect and try again.",
    );
  }
  request.sessionMutationCommitGuard?.();
}

function failure({ respond }: Request, error: unknown): void {
  respond(
    false,
    undefined,
    errorShape(
      error instanceof ChatBookmarkError ? ErrorCodes.INVALID_REQUEST : ErrorCodes.UNAVAILABLE,
      error instanceof ChatBookmarkError
        ? error.message
        : "Bookmark storage is unavailable. Retry shortly.",
    ),
  );
}

function currentSource(request: Request, params: ChatBookmarksCreateParams) {
  if (
    isIncognitoSessionKey(params.key) ||
    params.messageId.startsWith(CHAT_PENDING_INPUT_MESSAGE_PREFIX)
  ) {
    throw new ChatBookmarkError("Bookmark source is unavailable.");
  }
  const requested = resolveRequestedSessionAgentId(
    request.context.getRuntimeConfig(),
    params.key,
    params.agentId,
  );
  if (!requested.ok) {
    throw new ChatBookmarkError(requested.error.message);
  }
  const source = loadGatewaySessionEntryReadOnly(params.key, { agentId: requested.agentId });
  const selected = validateChatSelectedAgent({
    cfg: source.cfg,
    requestedSessionKey: params.key,
    explicitAgentId: params.agentId,
  });
  if (!selected.ok) {
    throw new ChatBookmarkError(selected.error);
  }
  const { entry, canonicalKey, storePath, agentId } = source;
  const visible = createSessionListEntryFilter({
    cfg: request.context.getRuntimeConfig(),
    client: request.client,
  });
  if (
    !entry ||
    !storePath ||
    canonicalKey !== params.key ||
    entry.incognito === true ||
    entry.sessionId !== params.sessionId ||
    visible?.(canonicalKey, entry) === false
  ) {
    throw new ChatBookmarkError("Bookmark source is unavailable.");
  }
  const page = readSessionTranscriptHistoryAnchorPage(
    {
      agentId,
      sessionKey: canonicalKey,
      sessionId: params.sessionId,
      sessionEntry: entry,
      storePath,
    },
    { messageId: params.messageId, maxMessages: 1 },
  );
  if (!page.found || !page.displaySource) {
    throw new ChatBookmarkError("Bookmark source is unavailable.");
  }
  return { ...source, entry, page };
}

export const chatBookmarkHandlers: GatewayRequestHandlers = {
  "chat.bookmarks.list": (request) => {
    const { params, respond } = request;
    if (
      !assertValidParams(params, validateChatBookmarksListParams, "chat.bookmarks.list", respond)
    ) {
      return;
    }
    try {
      const owner = requireProfile(request);
      if (owner) {
        // A profile-wide list needs no session; a scoped list uses the same canonical
        // agent selection as creation, without requiring an unavailable source to exist.
        if (params.key || params.agentId) {
          const requested = resolveRequestedSessionAgentId(
            request.context.getRuntimeConfig(),
            params.key,
            params.agentId,
          );
          if (!requested.ok) {
            respond(false, undefined, requested.error);
            return;
          }
          respond(true, listChatBookmarks(owner, { ...params, agentId: requested.agentId }));
        } else {
          respond(true, listChatBookmarks(owner, params));
        }
      }
    } catch (error) {
      failure(request, error);
    }
  },
  "chat.bookmarks.create": async (request) => {
    const { params, respond } = request;
    if (
      !assertValidParams(
        params,
        validateChatBookmarksCreateParams,
        "chat.bookmarks.create",
        respond,
      )
    ) {
      return;
    }
    try {
      const owner = requireProfile(request);
      if (!owner) {
        return;
      }
      assertMutationAuthority(request);
      const source = currentSource(request, params);
      // The ordinary history owner applies recovery/announce/display filters. No transcript
      // body is retained: only the exact persisted source admitted again below is written.
      const history = await readChatHistoryPage({
        entry: source.entry,
        provider: undefined,
        sessionId: params.sessionId,
        storePath: source.storePath,
        sessionAgentId: source.agentId,
        canonicalKey: source.canonicalKey,
        max: 1,
        maxHistoryBytes: 1_000_000,
        effectiveMaxChars: 1_000,
        offset: undefined,
        messageId: params.messageId,
        ignoreCliSessionImports: true,
      });
      if (
        !history.messages.some((message) => readChatHistoryMessageId(message) === params.messageId)
      ) {
        throw new ChatBookmarkError("Bookmark source is unavailable.");
      }
      const currentOwner = requireProfile(request);
      if (!currentOwner) {
        return;
      }
      if (currentOwner !== resolveUserProfileId(owner)) {
        throw new ChatBookmarkError("Bookmark owner changed. Retry.");
      }
      const bookmark = createChatBookmark(currentOwner, params.name, () => {
        // Admission may have awaited history while policy or caller authority changed.
        assertMutationAuthority(request);
        // After every yield, recheck current visibility, physical generation, and persisted
        // membership under synchronous write admission. Never adopt a reset's replacement.
        const latest = currentSource(request, params);
        if (
          latest.page.displaySource !== source.page.displaySource ||
          latest.page.totalMessages !== source.page.totalMessages ||
          latest.entry.lifecycleRevision !== source.entry.lifecycleRevision ||
          latest.entry.sessionStartedAt !== source.entry.sessionStartedAt
        ) {
          throw new ChatBookmarkError("Bookmark source changed. Retry.");
        }
        return {
          agentId: latest.agentId,
          sessionKey: latest.canonicalKey,
          sessionId: params.sessionId,
          messageId: params.messageId,
        };
      });
      respond(true, { bookmark });
    } catch (error) {
      failure(request, error);
    }
  },
  "chat.bookmarks.rename": (request) => {
    const { params, respond } = request;
    if (
      !assertValidParams(
        params,
        validateChatBookmarksRenameParams,
        "chat.bookmarks.rename",
        respond,
      )
    ) {
      return;
    }
    try {
      const owner = requireProfile(request);
      if (!owner) {
        return;
      }
      assertMutationAuthority(request);
      respond(true, { bookmark: renameChatBookmark(owner, params.bookmarkId, params.name) });
    } catch (error) {
      failure(request, error);
    }
  },
  "chat.bookmarks.remove": (request) => {
    const { params, respond } = request;
    if (
      !assertValidParams(
        params,
        validateChatBookmarksRemoveParams,
        "chat.bookmarks.remove",
        respond,
      )
    ) {
      return;
    }
    try {
      const owner = requireProfile(request);
      if (!owner) {
        return;
      }
      assertMutationAuthority(request);
      removeChatBookmark(owner, params.bookmarkId);
      respond(true, { ok: true });
    } catch (error) {
      failure(request, error);
    }
  },
};
