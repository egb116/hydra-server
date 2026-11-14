import { type InboxReply, RedditError } from "../contracts";

/**
 * Inbox parsing, ported unchanged from v1 tasks/CheckForMessages.ts.
 *
 * Reddit's inbox is now a notification feed (private messages moved to chat),
 * mostly Reddit's own suggestions. Like the app (APP:api/gql/Inbox.ts), only
 * replies and username mentions are kept.
 */

export interface GqlOperation {
  name: string;
  hash: string;
  /** The field under `data` the operation returns (see classifyQueryResponse). */
  rootField?: string;
}

export const GetInboxNotificationFeedV2: GqlOperation = {
  name: "GetInboxNotificationFeedV2",
  hash: "bfb3b015837f416e9ceb15d8c8082cd6bfc727124e8ac969eb25332c331ee614",
  rootField: "notificationInboxV2",
};

/** The app's page size, so the badge counts the same replies as the app does. */
export const PAGE_SIZE = 50;

/** The variables v1 (and the app's badge count) send for the first page. */
export const INBOX_VARIABLES: Readonly<Record<string, unknown>> = Object.freeze({
  pageSize: PAGE_SIZE,
  includeAnnouncement: false,
});

export const REPLY_TYPES: ReadonlySet<string> = new Set([
  "POST_REPLY",
  "COMMENT_REPLY",
  "USERNAME_MENTION",
]);

/** One feed node, with only the fields v1 reads, type-checked. */
export interface Notification {
  id: string;
  title?: string;
  body?: string;
  sentAt: string;
  readAt: string | null;
  deeplinkUrl?: string;
  comment?: {
    id?: string;
    content?: { preview?: string };
    authorInfo?: { displayName?: string };
  } | null;
  context?: { messageType?: string; post?: { title?: string } } | null;
}

// "2026-10-25T23:40:08.323000+0000" -> "2026-10-25T23:40:08.323+00:00"
export function parseTime(time: string): number {
  return Date.parse(time.replace(/(\.\d{3})\d+/, "$1").replace(/([+-]\d{2})(\d{2})$/, "$1:$2"));
}

/** The comment id a notification is about, if it's a reply or mention. */
export function getCommentId(node: Notification): string | undefined {
  const type = node.context?.messageType ?? "";
  if (!REPLY_TYPES.has(type) && !(node.comment && type.includes("REPLY"))) {
    return undefined;
  }
  if (node.comment?.id) return node.comment.id;
  // Mentions have no comment, but link to it: .../comments/<post>/<slug>/<id>/
  const match = (node.deeplinkUrl ?? "").match(
    /\/comments\/[^/]+\/[^/]+\/([a-z0-9]+)\/?(?:[?#].*)?$/i,
  );
  return match ? `t1_${match[1]}` : undefined;
}

/**
 * "<author> in <post title>" with the comment as the body. Mentions don't
 * come with their comment or post, so they use Reddit's own wording.
 */
export function getText(node: Notification): { title: string; body: string } | undefined {
  const author = node.comment?.authorInfo?.displayName;
  const postTitle = node.context?.post?.title;
  if (author && postTitle) {
    return {
      title: `${author} in ${postTitle}`,
      body: node.comment?.content?.preview ?? "",
    };
  }
  if (node.title) {
    return { title: node.title, body: node.body ?? "" };
  }
  return undefined;
}

/** A reply or mention, merged per comment: a reply that also pings the user arrives as both. */
export function getReplies(nodes: readonly Notification[]): InboxReply[] {
  const byComment = new Map<string, InboxReply>();
  for (const node of nodes) {
    const itemId = getCommentId(node);
    const text = getText(node);
    if (!itemId || !text) continue;
    const unread = !node.readAt;
    const sentAt = parseTime(node.sentAt);
    const existing = byComment.get(itemId);
    if (!existing) {
      byComment.set(itemId, { itemId, unread, sentAt, ...text });
      continue;
    }
    existing.unread &&= unread;
    existing.sentAt = Math.max(existing.sentAt, sentAt);
    // The reply's text is more specific than the mention's.
    if (node.comment) Object.assign(existing, text);
  }
  return [...byComment.values()];
}

// ------------------------------------------------------------ JSON narrowing

type Obj = Record<string, unknown>;

function isObj(value: unknown): value is Obj {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function obj(value: unknown): Obj | undefined {
  return isObj(value) ? value : undefined;
}

function str(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

/** Drops keys whose value is undefined, so optional fields stay absent. */
function compact<T extends Obj>(value: T): T {
  for (const key of Object.keys(value)) {
    if (value[key] === undefined) delete value[key];
  }
  return value;
}

/**
 * Reads one raw feed node into a Notification. Returns undefined for nodes v1
 * skips (no id or no sentAt). Fields of the wrong type are treated as absent.
 */
export function toNotification(raw: unknown): Notification | undefined {
  const node = obj(raw);
  const id = str(node?.["id"]);
  const sentAt = str(node?.["sentAt"]);
  if (!node || !id || !sentAt) return undefined;

  const rawComment = node["comment"];
  let comment: Notification["comment"];
  if (rawComment === null) comment = null;
  else {
    const c = obj(rawComment);
    if (c) {
      const preview = str(obj(c["content"])?.["preview"]);
      const displayName = str(obj(c["authorInfo"])?.["displayName"]);
      comment = compact({
        id: str(c["id"]),
        content: preview === undefined ? undefined : { preview },
        authorInfo: displayName === undefined ? undefined : { displayName },
      });
    }
  }

  const rawContext = node["context"];
  let context: Notification["context"];
  if (rawContext === null) context = null;
  else {
    const c = obj(rawContext);
    if (c) {
      const postTitle = str(obj(c["post"])?.["title"]);
      context = compact({
        messageType: str(c["messageType"]),
        post: postTitle === undefined ? undefined : { title: postTitle },
      });
    }
  }

  return compact({
    id,
    sentAt,
    readAt: str(node["readAt"]) ?? null,
    title: str(node["title"]),
    body: str(node["body"]),
    deeplinkUrl: str(node["deeplinkUrl"]),
    comment,
    context,
  });
}

export interface ParsedInbox {
  replies: InboxReply[];
  /** v1's badge: unread replies on the first page. */
  unreadCount: number;
}

/**
 * Parses the `data` of a GetInboxNotificationFeedV2 response. A missing
 * notificationInboxV2 means the session is dead: a very old session still
 * gets a token, but not one for the account.
 */
export function parseInboxData(data: unknown): ParsedInbox {
  const inbox = obj(obj(data)?.["notificationInboxV2"]);
  if (!inbox) {
    throw new RedditError(
      "session_dead",
      "Reddit returned no inbox. The session may have expired.",
    );
  }
  const edges = obj(inbox["elements"])?.["edges"];
  const nodes = (Array.isArray(edges) ? edges : [])
    .map((edge: unknown) => toNotification(obj(edge)?.["node"]))
    .filter((node): node is Notification => node !== undefined);
  const replies = getReplies(nodes);
  return { replies, unreadCount: replies.filter((reply) => reply.unread).length };
}
