import { html, nothing } from "lit";
import { repeat } from "lit/directives/repeat.js";
import type { ChatBookmark } from "../../../../../packages/gateway-protocol/src/index.js";
import "../../../components/modal-dialog.ts";
import { t } from "../../../i18n/index.ts";
import { sessionNavigationTarget } from "../../../lib/sessions/route-navigation.ts";
import type { ChatBookmarks } from "../chat-bookmarks.ts";
import "./chat-bookmarks.css";

export function renderChatBookmarksDialog(
  state: ChatBookmarks,
  actions: {
    basePath?: string;
    update: () => void;
    open: (bookmark: ChatBookmark) => void;
  },
) {
  if (!state.open || !state.scope) {
    return nothing;
  }
  const scope = state.scope;
  const current = () => state.scope === scope && scope.isCurrent();
  // A queued DOM event must not act on a replacement profile/session projection.
  const guardOwner = {
    capture: true,
    handleEvent(event: Event) {
      if (!current()) {
        event.preventDefault();
        event.stopImmediatePropagation();
      }
    },
  };
  const editor = state.editor;
  const nameLength = Array.from(editor?.name.trim() ?? "").length;
  const close = () => {
    if (!current()) {
      return;
    }
    state.open = false;
    state.editor = null;
    actions.update();
  };
  const title = t(
    editor
      ? editor.bookmarkId
        ? "chat.bookmarks.rename"
        : "chat.bookmarks.add"
      : "chat.bookmarks.title",
  );
  return html`
    <openclaw-modal-dialog label=${title} @modal-cancel=${close}>
      <section
        class="exec-approval-card chat-bookmarks-dialog"
        @click=${guardOwner}
        @input=${guardOwner}
        @change=${guardOwner}
        @submit=${guardOwner}
      >
        <h2>${title}</h2>
        <p class="muted">${t("chat.bookmarks.personal")}</p>
        ${state.error ? html`<p role="alert">${state.error}</p>` : nothing}
        ${
          editor
            ? html` <form
                @submit=${(event: SubmitEvent) => {
                  event.preventDefault();
                  void state.save();
                }}
              >
                <label class="field">
                  <span>${t("chat.bookmarks.name")}</span>
                  <input
                    autofocus
                    .value=${editor.name}
                    ?disabled=${state.saving}
                    @input=${(event: Event) => {
                      if (event.currentTarget instanceof HTMLInputElement) {
                        editor.name = event.currentTarget.value;
                        actions.update();
                      }
                    }}
                  />
                </label>
                <p class="muted" aria-live="polite">
                  ${t("chat.bookmarks.nameLimit", { count: String(nameLength) })}
                </p>
                <div class="exec-approval-actions">
                  <button
                    class="btn"
                    type="button"
                    ?disabled=${state.saving}
                    @click=${() => state.show()}
                  >
                    ${t("common.cancel")}
                  </button>
                  <button
                    class="btn primary"
                    type="submit"
                    ?disabled=${state.saving || nameLength < 1 || nameLength > 70}
                  >
                    ${t("common.save")}
                  </button>
                </div>
              </form>`
            : html` <label class="field checkbox">
                  <input
                    type="checkbox"
                    .checked=${state.allConversations}
                    @change=${(event: Event) => {
                      if (event.currentTarget instanceof HTMLInputElement) {
                        state.allConversations = event.currentTarget.checked;
                        void state.search(state.query);
                      }
                    }}
                  />
                  <span>${t("chat.bookmarks.allConversations")}</span>
                </label>
                <label class="field">
                  <span>${t("chat.bookmarks.search")}</span>
                  <input
                    type="search"
                    autofocus
                    .value=${state.query}
                    @input=${(event: Event) => {
                      if (event.currentTarget instanceof HTMLInputElement) {
                        void state.search(event.currentTarget.value);
                      }
                    }}
                  />
                </label>
                <ul class="chat-bookmarks-dialog__list" aria-busy=${state.loading}>
                  ${repeat(
                    state.results,
                    (item) => item.id,
                    (item) => {
                      const currentConversation =
                        item.sessionKey === scope.key && item.agentId === scope.agentId;
                      const missing =
                        (currentConversation && item.sessionId !== scope.sessionId) ||
                        state.unavailable.has(item.id);
                      return html`<li class="chat-bookmarks-dialog__item">
                        <div class="chat-bookmarks-dialog__source">
                          ${
                            currentConversation
                              ? html`<button
                                  class="btn btn--ghost"
                                  type="button"
                                  ?disabled=${missing}
                                  @click=${() => actions.open(item)}
                                >
                                  ${item.name}
                                </button>`
                              : html`<span>${item.name}</span>
                                  <a
                                    class="btn btn--ghost"
                                    href=${
                                      sessionNavigationTarget({
                                        face: "chat",
                                        sessionKey: item.sessionKey,
                                        fallbackAgentId: item.agentId,
                                        basePath: actions.basePath,
                                        exactKey: true,
                                      }).href
                                    }
                                    >${t("chat.bookmarks.openConversation")}</a
                                  >`
                          }
                          ${missing ? html`<span class="muted">${t("chat.bookmarks.unavailable")}</span>` : nothing}
                        </div>
                        ${
                          state.scope?.canWrite
                            ? html` <button
                                  class="btn btn--ghost"
                                  type="button"
                                  ?disabled=${state.saving}
                                  @click=${() => state.edit(item.messageId, item)}
                                >
                                  ${t("chat.bookmarks.rename")}
                                </button>
                                <button
                                  class="btn btn--ghost"
                                  type="button"
                                  ?disabled=${state.saving}
                                  @click=${() => {
                                    void state.remove(item);
                                  }}
                                >
                                  ${t("chat.bookmarks.remove")}
                                </button>`
                            : nothing
                        }
                      </li>`;
                    },
                  )}
                </ul>
                ${
                  state.loading
                    ? html`<p role="status">${t("common.loading")}</p>`
                    : state.results.length === 0
                      ? html`<p>${t("chat.bookmarks.empty")}</p>`
                      : nothing
                }
                ${
                  state.nextCursor
                    ? html`<button
                        class="btn"
                        type="button"
                        ?disabled=${state.loading}
                        @click=${() => {
                          void state.search(state.query, true);
                        }}
                      >
                        ${t("chat.bookmarks.more")}
                      </button>`
                    : nothing
                }
                <footer class="exec-approval-actions">
                  <button
                    class="btn"
                    type="button"
                    ?disabled=${state.loading}
                    @click=${() => state.changed()}
                  >
                    ${t("chat.bookmarks.reload")}
                  </button>
                  <button class="btn primary" type="button" @click=${close}>
                    ${t("common.close")}
                  </button>
                </footer>`
        }
      </section>
    </openclaw-modal-dialog>
  `;
}
