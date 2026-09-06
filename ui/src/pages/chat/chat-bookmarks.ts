import type { ChatBookmark } from "../../../../packages/gateway-protocol/src/index.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { formatUiError } from "../../lib/format-error.ts";

export type ChatBookmarkScope = {
  client: GatewayBrowserClient;
  generation: number;
  profileId: string;
  agentId: string;
  key: string;
  sessionId: string;
  canWrite: boolean;
  isCurrent: () => boolean;
};

export type ChatBookmarkAccess = {
  revision: number;
  bookmarks: readonly ChatBookmark[];
  selectedId: string | null;
  revealId: string | null;
  toggle?: (messageId: string) => void;
  edit?: (messageId: string) => void;
  open: (bookmark: ChatBookmark) => void;
};

/** Pane-local projection only. The authenticated Gateway profile owns persistence. */
export class ChatBookmarks {
  scope: ChatBookmarkScope | null = null;
  bookmarks: ChatBookmark[] = [];
  results: ChatBookmark[] = [];
  revision = 0;
  query = "";
  allConversations = false;
  nextCursor: string | undefined;
  loading = false;
  indexReady = false;
  saving = false;
  error: string | null = null;
  open = false;
  editor: { messageId: string; bookmarkId?: string; name: string } | null = null;
  selectedId: string | null = null;
  revealId: string | null = null;
  unavailable = new Set<string>();
  private listAttempt = 0;
  private indexAttempt = 0;

  constructor(private readonly update: () => void) {}

  bind(scope: ChatBookmarkScope | null): void {
    const previous = this.scope;
    if (
      previous &&
      scope &&
      previous.client === scope.client &&
      previous.generation === scope.generation &&
      previous.profileId === scope.profileId &&
      previous.agentId === scope.agentId &&
      previous.key === scope.key &&
      previous.sessionId === scope.sessionId &&
      previous.canWrite === scope.canWrite &&
      previous.isCurrent()
    ) {
      return;
    }
    if (!previous && !scope) {
      return;
    }
    this.scope = scope;
    this.listAttempt++;
    this.indexAttempt++;
    this.bookmarks = [];
    this.indexReady = false;
    this.results = [];
    this.query = "";
    this.allConversations = false;
    this.nextCursor = undefined;
    this.loading = false;
    this.saving = false;
    this.error = null;
    this.open = false;
    this.editor = null;
    this.selectedId = null;
    this.revealId = null;
    this.unavailable.clear();
    this.revision++;
    if (scope) {
      void this.refreshIndex();
    }
  }

  private current(scope: ChatBookmarkScope): boolean {
    return this.scope === scope && scope.isCurrent();
  }

  async refreshIndex(): Promise<void> {
    const scope = this.scope;
    if (!scope || !this.current(scope)) {
      return;
    }
    const attempt = ++this.indexAttempt;
    const bookmarks: ChatBookmark[] = [];
    let cursor: string | undefined;
    try {
      // Consume every page: rail/action selection must not stop at the default 50.
      do {
        const page = await scope.client.request<{ bookmarks: ChatBookmark[]; nextCursor?: string }>(
          "chat.bookmarks.list",
          { key: scope.key, agentId: scope.agentId, limit: 100, ...(cursor ? { cursor } : {}) },
        );
        if (!this.current(scope) || attempt !== this.indexAttempt) {
          return;
        }
        bookmarks.push(...page.bookmarks);
        cursor = page.nextCursor;
      } while (cursor);
      this.bookmarks = bookmarks;
      this.indexReady = true;
      this.revision++;
    } catch (error) {
      if (!this.current(scope) || attempt !== this.indexAttempt) {
        return;
      }
      this.indexReady = false;
      this.revision++;
      this.error = formatUiError(error);
    }
    this.update();
  }

  show(): void {
    this.open = true;
    this.editor = null;
    // Reopening the library picks up this profile's changes from other clients.
    void this.refreshIndex();
    void this.search("");
  }

  async search(query: string, more = false): Promise<void> {
    const scope = this.scope;
    if (!scope || !this.current(scope) || (more && (!this.nextCursor || this.loading))) {
      return;
    }
    const cursor = more ? this.nextCursor : undefined;
    const attempt = ++this.listAttempt;
    this.query = query;
    this.loading = true;
    this.error = null;
    if (!more) {
      this.results = [];
      this.nextCursor = undefined;
    }
    this.update();
    try {
      const page = await scope.client.request<{ bookmarks: ChatBookmark[]; nextCursor?: string }>(
        "chat.bookmarks.list",
        {
          ...(this.allConversations ? {} : { key: scope.key, agentId: scope.agentId }),
          query,
          ...(cursor ? { cursor } : {}),
        },
      );
      if (!this.current(scope) || attempt !== this.listAttempt) {
        return;
      }
      this.results = more ? [...this.results, ...page.bookmarks] : page.bookmarks;
      this.nextCursor = page.nextCursor;
    } catch (error) {
      if (!this.current(scope) || attempt !== this.listAttempt) {
        return;
      }
      this.error = formatUiError(error);
    }
    this.loading = false;
    this.update();
  }

  toggle(messageId: string): void {
    const scope = this.scope;
    if (!scope?.canWrite || !this.current(scope) || !this.indexReady) {
      return;
    }
    const saved = this.bookmarks.find(
      (item) =>
        item.messageId === messageId &&
        item.agentId === scope.agentId &&
        item.sessionId === scope.sessionId,
    );
    if (saved) {
      void this.remove(saved);
    } else {
      this.edit(messageId);
    }
  }

  edit(messageId: string, bookmark?: ChatBookmark): void {
    if (!this.scope?.canWrite || !this.current(this.scope) || (!bookmark && !this.indexReady)) {
      return;
    }
    const saved =
      bookmark ??
      this.bookmarks.find(
        (item) =>
          item.messageId === messageId &&
          item.sessionId === this.scope?.sessionId &&
          item.agentId === this.scope?.agentId,
      );
    this.editor = { messageId, bookmarkId: saved?.id, name: saved?.name ?? "" };
    this.open = true;
    this.error = null;
    this.update();
  }

  async save(): Promise<void> {
    const scope = this.scope;
    const editor = this.editor;
    const name = editor?.name.trim() ?? "";
    if (
      !scope?.canWrite ||
      !editor ||
      !this.current(scope) ||
      this.saving ||
      !name ||
      Array.from(name).length > 70
    ) {
      return;
    }
    await this.mutate(
      editor.bookmarkId ? "chat.bookmarks.rename" : "chat.bookmarks.create",
      editor.bookmarkId
        ? { bookmarkId: editor.bookmarkId, name }
        : {
            key: scope.key,
            agentId: scope.agentId,
            sessionId: scope.sessionId,
            messageId: editor.messageId,
            name,
          },
    );
  }

  async remove(bookmark: ChatBookmark): Promise<void> {
    await this.mutate("chat.bookmarks.remove", { bookmarkId: bookmark.id });
  }

  private async mutate(method: string, params: Record<string, unknown>): Promise<void> {
    const scope = this.scope;
    if (!scope?.canWrite || !this.current(scope) || this.saving) {
      return;
    }
    const closeEditor = this.editor !== null;
    this.saving = true;
    this.error = null;
    this.update();
    try {
      await scope.client.request(method, params);
      if (!this.current(scope)) {
        return;
      }
      this.editor = null;
      await Promise.all([this.refreshIndex(), this.search(this.query)]);
      if (this.current(scope)) {
        this.open = this.error !== null || (!closeEditor && this.open);
      }
    } catch (error) {
      if (!this.current(scope)) {
        return;
      }
      this.error = formatUiError(error);
      // Footer toggles have no open dialog to carry a failure. Surface it explicitly.
      this.open = true;
    }
    if (this.current(scope)) {
      this.saving = false;
      this.update();
    }
  }

  changed(): void {
    this.unavailable.clear();
    this.error = null;
    void this.refreshIndex();
    if (this.open && !this.editor) {
      void this.search(this.query);
    }
  }
}
