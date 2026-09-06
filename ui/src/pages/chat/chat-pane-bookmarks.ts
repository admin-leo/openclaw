import type { ChatBookmark } from "../../../../packages/gateway-protocol/src/index.js";
import { isIncognitoSessionKey } from "../../../../src/shared/incognito-session-key.js";
import { hasOperatorReadAccess, hasOperatorWriteAccess } from "../../app/operator-access.ts";
import { t } from "../../i18n/index.ts";
import { parseCatalogSessionKey } from "../../lib/sessions/catalog-key.ts";
import { canonicalUiSessionKeyForPersistence } from "../../lib/sessions/session-key.ts";
import { ChatBookmarks, type ChatBookmarkAccess } from "./chat-bookmarks.ts";
import { ChatPaneReplyNavigation } from "./chat-pane-reply-navigation.ts";
import { resolveChatAgentId, selectedChatSessionRow } from "./chat-state-route.ts";
import { persistedMessageEntryId } from "./chat-thread.ts";
import { renderChatBookmarksDialog } from "./components/chat-bookmarks-dialog.ts";
import {
  closeTranscriptSearch,
  getTranscriptState,
} from "./components/chat-thread-interactions.ts";

export abstract class ChatPaneBookmarks extends ChatPaneReplyNavigation {
  protected readonly bookmarks = new ChatBookmarks(() => this.requestUpdate());
  private bookmarkNavigation: symbol | null = null;

  protected syncBookmarks(): ChatBookmarkAccess | undefined {
    const connection = this.captureConnectionScope();
    const snapshot = this.context.gateway.snapshot;
    // Presence/display aliases are not authenticated profile identities.
    const identity = snapshot.selfUser?.identity;
    const state = this.state;
    const selectedKey = state?.sessionKey ?? "";
    const key = state ? canonicalUiSessionKeyForPersistence(state, selectedKey) : "";
    const sessionId = state?.currentSessionId ?? "";
    const agentId = state ? resolveChatAgentId(state) : "";
    const row = state ? selectedChatSessionRow(state) : undefined;
    const profileId = identity?.type === "profile" ? identity.id : null;
    const canWrite = hasOperatorWriteAccess(snapshot.hello?.auth ?? null);
    this.bookmarks.bind(
      connection &&
        profileId &&
        sessionId &&
        !row?.incognito &&
        !state?.selectedChatSessionIncognito &&
        !isIncognitoSessionKey(key) &&
        !parseCatalogSessionKey(key) &&
        hasOperatorReadAccess(snapshot.hello?.auth ?? null)
        ? {
            client: connection.client,
            generation: connection.generation,
            profileId,
            agentId,
            key,
            sessionId,
            canWrite,
            isCurrent: () =>
              this.isConnectionScopeCurrent(connection) &&
              resolveChatAgentId(connection.state) === agentId &&
              connection.state.sessionKey === selectedKey &&
              connection.state.currentSessionId === sessionId &&
              this.context.gateway.snapshot.selfUser?.identity?.type === "profile" &&
              this.context.gateway.snapshot.selfUser.identity.id === profileId &&
              !selectedChatSessionRow(connection.state)?.incognito &&
              !connection.state.selectedChatSessionIncognito &&
              hasOperatorReadAccess(this.context.gateway.snapshot.hello?.auth ?? null) &&
              hasOperatorWriteAccess(this.context.gateway.snapshot.hello?.auth ?? null) ===
                canWrite,
          }
        : null,
    );
    const scope = this.bookmarks.scope;
    if (!scope) {
      return undefined;
    }
    const current = () => this.bookmarks.scope === scope && scope.isCurrent();
    return {
      revision: this.bookmarks.revision,
      bookmarks: this.bookmarks.bookmarks.filter(
        (item) => item.sessionId === sessionId && item.agentId === agentId,
      ),
      selectedId: this.bookmarks.selectedId,
      revealId: this.bookmarks.revealId,
      toggle:
        scope.canWrite && this.bookmarks.indexReady
          ? (id) => {
              if (current()) {
                this.bookmarks.toggle(id);
              }
            }
          : undefined,
      edit:
        scope.canWrite && this.bookmarks.indexReady
          ? (id) => {
              if (current()) {
                this.bookmarks.edit(id);
              }
            }
          : undefined,
      open: (bookmark) => {
        if (current()) {
          void this.openBookmark(bookmark);
        }
      },
    };
  }

  protected renderBookmarksDialog() {
    return renderChatBookmarksDialog(this.bookmarks, {
      basePath: this.context.basePath,
      update: () => this.requestUpdate(),
      open: (bookmark) => {
        void this.openBookmark(bookmark);
      },
    });
  }

  override disconnectedCallback() {
    this.bookmarkNavigation = null;
    this.bookmarks.bind(null);
    super.disconnectedCallback();
  }

  private async openBookmark(bookmark: ChatBookmark): Promise<void> {
    const scope = this.bookmarks.scope;
    const state = this.state;
    if (!scope || !state || !scope.isCurrent()) {
      return;
    }
    const navigation = Symbol("bookmark-navigation");
    this.bookmarkNavigation = navigation;
    const current = () =>
      this.bookmarkNavigation === navigation && this.bookmarks.scope === scope && scope.isCurrent();
    const unavailable = () => {
      this.bookmarks.unavailable.add(bookmark.id);
      this.bookmarks.error = t("chat.bookmarks.unavailable");
      this.bookmarks.open = true;
      this.bookmarks.revealId = null;
      this.requestUpdate();
    };
    // A reset can reuse a session key and even an entry ID. Never follow it.
    if (
      bookmark.agentId !== scope.agentId ||
      bookmark.sessionId !== scope.sessionId ||
      bookmark.sessionKey !== scope.key
    ) {
      unavailable();
      return;
    }
    this.bookmarks.error = null;
    try {
      while (
        !state.chatMessages.some(
          (message) => persistedMessageEntryId(message) === bookmark.messageId,
        )
      ) {
        if (!current()) {
          return;
        }
        if (!state.chatHistoryPagination.hasMore || !(await this.loadOlderMessages())) {
          if (current()) {
            unavailable();
          }
          return;
        }
      }
      if (!current()) {
        return;
      }
      closeTranscriptSearch(getTranscriptState(this.paneId), () => this.requestUpdate());
      this.bookmarks.selectedId = bookmark.id;
      // Retained until another target/session: folding immediately after scroll
      // would hide the very source the reader asked to see.
      this.bookmarks.revealId = bookmark.messageId;
      this.bookmarks.revision++;
      this.bookmarks.open = false;
      this.requestUpdate();
      await this.updateComplete;
      if (!current()) {
        return;
      }
      const visible = await new Promise<boolean>((resolve) => {
        if (
          !this.transcript.revealMessage(bookmark.messageId, {
            isCurrent: current,
            onRevealed: resolve,
          })
        ) {
          resolve(false);
        }
      });
      if (current() && !visible) {
        unavailable();
      }
    } catch {
      if (current()) {
        unavailable();
      }
    }
  }
}
