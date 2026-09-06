import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import {
  CHAT_BOOKMARK_NAME_MAX_LENGTH,
  type ChatBookmark,
  type ChatBookmarksListParams,
  type ChatBookmarksListResult,
} from "../../packages/gateway-protocol/src/schema/logs-chat.js";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "../infra/kysely-sync.js";
import { tableExists } from "./openclaw-state-db-schema-helpers.js";
import type { DB } from "./openclaw-state-db.generated.js";
import {
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
  type OpenClawStateDatabaseOptions,
} from "./openclaw-state-db.js";
import { OPENCLAW_STATE_SCHEMA_SQL } from "./openclaw-state-schema.js";
import { requireResolvedUserProfileById } from "./user-profiles-internal.js";

type BookmarkDatabase = Pick<DB, "chat_bookmarks">;
type BookmarkRow = BookmarkDatabase["chat_bookmarks"];
export type ChatBookmarkSource = Pick<
  ChatBookmark,
  "agentId" | "sessionKey" | "sessionId" | "messageId"
>;

export class ChatBookmarkError extends Error {}

function normalizeName(name: string): string {
  const normalized = name.trim();
  if (
    !normalized ||
    Array.from(normalized).length > CHAT_BOOKMARK_NAME_MAX_LENGTH ||
    normalized.includes("\0")
  ) {
    throw new ChatBookmarkError("Bookmark name must contain 1–70 Unicode characters.");
  }
  return normalized;
}

// NFC and Unicode lowercase are identical for persisted names and query terms.
// Lowercasing can expand a 70-code-point label to at most 140 code points.
function foldName(value: string): string {
  return value.normalize("NFC").toLowerCase().normalize("NFC");
}

function ensureSchema(db: DatabaseSync): void {
  const start = OPENCLAW_STATE_SCHEMA_SQL.indexOf("CREATE TABLE IF NOT EXISTS chat_bookmarks (");
  const marker = "ON chat_bookmarks(profile_id, created_at_ms DESC, id DESC);";
  const end = OPENCLAW_STATE_SCHEMA_SQL.indexOf(marker, start);
  if (start < 0 || end < start) {
    throw new Error("Chat bookmark schema marker is missing.");
  }
  // sqlite-allow-raw -- Canonical first-use DDL; all bookmark rows use Kysely.
  db.exec(OPENCLAW_STATE_SCHEMA_SQL.slice(start, end + marker.length));
}

function toBookmark(row: BookmarkRow): ChatBookmark {
  return {
    id: row.id,
    agentId: row.agent_id,
    sessionKey: row.session_key,
    sessionId: row.session_id,
    messageId: row.message_id,
    name: row.name,
    createdAt: row.created_at_ms,
    updatedAt: row.updated_at_ms,
  };
}

function bookmarkDb(db: DatabaseSync) {
  return getNodeSqliteKysely<BookmarkDatabase>(db);
}

function decodeCursor(cursor: string): { createdAt: number; id: string } {
  try {
    if (cursor.length > 512 || !/^[A-Za-z0-9_-]+$/.test(cursor)) {
      throw new Error();
    }
    const value: unknown = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
    if (
      typeof value !== "object" ||
      value === null ||
      !("createdAt" in value) ||
      !("id" in value) ||
      typeof value.createdAt !== "number" ||
      !Number.isSafeInteger(value.createdAt) ||
      value.createdAt < 0 ||
      typeof value.id !== "string" ||
      !value.id ||
      value.id.length > 128
    ) {
      throw new Error();
    }
    return { createdAt: value.createdAt, id: value.id };
  } catch {
    throw new ChatBookmarkError("Invalid bookmark cursor.");
  }
}

export function listChatBookmarks(
  profileId: string,
  params: ChatBookmarksListParams = {},
  options: OpenClawStateDatabaseOptions = {},
): ChatBookmarksListResult {
  const limit = params.limit ?? 50;
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    throw new ChatBookmarkError("Invalid bookmark limit.");
  }
  const cursor = params.cursor ? decodeCursor(params.cursor) : undefined;
  const { db } = openOpenClawStateDatabase(options);
  const owner = requireResolvedUserProfileById(db, profileId).id;
  // Browsing an unused library does not create privacy-sensitive storage.
  if (!tableExists(db, "chat_bookmarks")) {
    return { bookmarks: [] };
  }
  let query = bookmarkDb(db)
    .selectFrom("chat_bookmarks")
    .selectAll()
    .where("profile_id", "=", owner);
  if (params.key) {
    query = query.where("session_key", "=", params.key);
  }
  if (params.agentId) {
    query = query.where("agent_id", "=", params.agentId);
  }
  const queryText = params.query;
  if (queryText) {
    query = query.where((eb) =>
      eb(eb.fn<number>("instr", [eb.ref("name_folded"), eb.val(foldName(queryText))]), ">", 0),
    );
  }
  if (cursor) {
    query = query.where((eb) =>
      eb.or([
        eb("created_at_ms", "<", cursor.createdAt),
        eb.and([eb("created_at_ms", "=", cursor.createdAt), eb("id", "<", cursor.id)]),
      ]),
    );
  }
  const rows = executeSqliteQuerySync(
    db,
    query
      .orderBy("created_at_ms", "desc")
      .orderBy("id", "desc")
      .limit(limit + 1),
  ).rows;
  const bookmarks = rows.slice(0, limit).map(toBookmark);
  const last = bookmarks.at(-1);
  return {
    bookmarks,
    ...(rows.length > limit && last
      ? {
          nextCursor: Buffer.from(
            JSON.stringify({ createdAt: last.createdAt, id: last.id }),
          ).toString("base64url"),
        }
      : {}),
  };
}

/** Source admission runs synchronously under write admission, before either DDL or row mutation. */
export function createChatBookmark(
  profileId: string,
  name: string,
  admitSource: () => ChatBookmarkSource,
  options: OpenClawStateDatabaseOptions = {},
): ChatBookmark {
  const normalized = normalizeName(name);
  return runOpenClawStateWriteTransaction(
    ({ db }) => {
      const owner = requireResolvedUserProfileById(db, profileId).id;
      const source = admitSource();
      ensureSchema(db);
      const now = Date.now();
      const row = executeSqliteQueryTakeFirstSync(
        db,
        bookmarkDb(db)
          .insertInto("chat_bookmarks")
          .values({
            id: randomUUID(),
            profile_id: owner,
            agent_id: source.agentId,
            session_key: source.sessionKey,
            session_id: source.sessionId,
            message_id: source.messageId,
            name: normalized,
            name_folded: foldName(normalized),
            created_at_ms: now,
            updated_at_ms: now,
          })
          .onConflict((oc) =>
            oc
              .columns(["profile_id", "agent_id", "session_key", "session_id", "message_id"])
              .doUpdateSet({
                name: normalized,
                name_folded: foldName(normalized),
                updated_at_ms: now,
              }),
          )
          .returningAll(),
      );
      if (!row) {
        throw new Error("Bookmark write returned no row.");
      }
      return toBookmark(row);
    },
    options,
    { operationLabel: "chat.bookmarks.create" },
  );
}

export function renameChatBookmark(
  profileId: string,
  bookmarkId: string,
  name: string,
  options: OpenClawStateDatabaseOptions = {},
): ChatBookmark {
  const normalized = normalizeName(name);
  return runOpenClawStateWriteTransaction(
    ({ db }) => {
      const owner = requireResolvedUserProfileById(db, profileId).id;
      if (!tableExists(db, "chat_bookmarks")) {
        throw new ChatBookmarkError("Bookmark not found.");
      }
      const row = executeSqliteQueryTakeFirstSync(
        db,
        bookmarkDb(db)
          .updateTable("chat_bookmarks")
          .set({ name: normalized, name_folded: foldName(normalized), updated_at_ms: Date.now() })
          .where("profile_id", "=", owner)
          .where("id", "=", bookmarkId)
          .returningAll(),
      );
      if (!row) {
        throw new ChatBookmarkError("Bookmark not found.");
      }
      return toBookmark(row);
    },
    options,
    { operationLabel: "chat.bookmarks.rename" },
  );
}

export function removeChatBookmark(
  profileId: string,
  bookmarkId: string,
  options: OpenClawStateDatabaseOptions = {},
): void {
  runOpenClawStateWriteTransaction(
    ({ db }) => {
      const owner = requireResolvedUserProfileById(db, profileId).id;
      if (!tableExists(db, "chat_bookmarks")) {
        return;
      }
      executeSqliteQuerySync(
        db,
        bookmarkDb(db)
          .deleteFrom("chat_bookmarks")
          .where("profile_id", "=", owner)
          .where("id", "=", bookmarkId),
      );
    },
    options,
    { operationLabel: "chat.bookmarks.remove" },
  );
}

/** Called in the profile owner's merge transaction. Identical sources keep the target's label. */
export function mergeChatBookmarks(
  db: DatabaseSync,
  sourceProfileId: string,
  targetProfileId: string,
): void {
  if (sourceProfileId === targetProfileId || !tableExists(db, "chat_bookmarks")) {
    return;
  }
  const kysely = bookmarkDb(db);
  // Delete only duplicate references before moving rows; IDs and all distinct generations survive.
  executeSqliteQuerySync(
    db,
    kysely
      .deleteFrom("chat_bookmarks")
      .where("profile_id", "=", sourceProfileId)
      .where((eb) =>
        eb.exists(
          eb
            .selectFrom("chat_bookmarks as target")
            .select("target.id")
            .where("target.profile_id", "=", targetProfileId)
            .whereRef("target.agent_id", "=", "chat_bookmarks.agent_id")
            .whereRef("target.session_key", "=", "chat_bookmarks.session_key")
            .whereRef("target.session_id", "=", "chat_bookmarks.session_id")
            .whereRef("target.message_id", "=", "chat_bookmarks.message_id"),
        ),
      ),
  );
  executeSqliteQuerySync(
    db,
    kysely
      .updateTable("chat_bookmarks")
      .set({ profile_id: targetProfileId })
      .where("profile_id", "=", sourceProfileId),
  );
}
