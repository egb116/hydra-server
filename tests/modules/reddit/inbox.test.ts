import { describe, expect, test } from "bun:test";
import { RedditError } from "../../../src/modules/contracts";
import {
  GetInboxNotificationFeedV2,
  getCommentId,
  getReplies,
  getText,
  INBOX_VARIABLES,
  type Notification,
  PAGE_SIZE,
  parseInboxData,
  parseTime,
  REPLY_TYPES,
  toNotification,
} from "../../../src/modules/reddit/inbox";
import {
  BROKEN_NODE,
  FULL_INBOX,
  inboxResponse,
  LONE_MENTION_NODE,
  MENTION_OF_REPLY_NODE,
  NO_INBOX_RESPONSE,
  POST_REPLY_NODE,
  REPLY_NODE,
  SUGGESTION_NODE,
} from "./fixtures";

const node = (raw: unknown): Notification => {
  const n = toNotification(raw);
  if (!n) throw new Error("fixture did not parse");
  return n;
};

describe("operation constants (unchanged from v1)", () => {
  test("name, hash, variables, reply types", () => {
    expect(GetInboxNotificationFeedV2).toEqual({
      name: "GetInboxNotificationFeedV2",
      hash: "bfb3b015837f416e9ceb15d8c8082cd6bfc727124e8ac969eb25332c331ee614",
      rootField: "notificationInboxV2",
    });
    expect(PAGE_SIZE).toBe(50);
    expect(INBOX_VARIABLES).toEqual({ pageSize: 50, includeAnnouncement: false });
    expect([...REPLY_TYPES].sort()).toEqual(["COMMENT_REPLY", "POST_REPLY", "USERNAME_MENTION"]);
  });
});

describe("parseTime", () => {
  test("microseconds and +0000 offsets", () => {
    expect(parseTime("2026-10-25T23:40:08.323000+0000")).toBe(
      Date.parse("2026-10-25T23:40:08.323Z"),
    );
    expect(parseTime("2026-10-25T23:40:08.323456-0130")).toBe(
      Date.parse("2026-10-26T01:10:08.323Z"),
    );
  });

  test("already-ISO strings pass through", () => {
    expect(parseTime("2026-10-25T23:40:08.323Z")).toBe(Date.parse("2026-10-25T23:40:08.323Z"));
    expect(parseTime("2026-10-25T23:40:08+00:00")).toBe(Date.parse("2026-10-25T23:40:08Z"));
  });

  test("garbage is NaN (never newer than a baseline)", () => {
    expect(parseTime("yesterday")).toBeNaN();
  });
});

describe("getCommentId", () => {
  test("a reply uses its comment id", () => {
    expect(getCommentId(node(REPLY_NODE))).toBe("t1_abc123");
    expect(getCommentId(node(POST_REPLY_NODE))).toBe("t1_ghi789");
  });

  test("a mention without a comment takes the id from the deeplink", () => {
    expect(getCommentId(node(MENTION_OF_REPLY_NODE))).toBe("t1_abc123");
    expect(getCommentId(node(LONE_MENTION_NODE))).toBe("t1_def456");
  });

  test("a mention whose link has no comment segment is skipped", () => {
    const n = node({
      ...LONE_MENTION_NODE,
      deeplinkUrl: "https://www.reddit.com/r/typescript/comments/1qwert/some_slug/",
    });
    expect(getCommentId(n)).toBeUndefined();
  });

  test("suggestions are not replies", () => {
    expect(getCommentId(node(SUGGESTION_NODE))).toBeUndefined();
  });

  test("an unknown *REPLY* type counts only when it carries a comment", () => {
    const withComment = node({
      ...REPLY_NODE,
      context: { messageType: "PRIVATE_COMMENT_REPLY", post: { title: "t" } },
    });
    expect(getCommentId(withComment)).toBe("t1_abc123");
    const withoutComment = node({
      ...MENTION_OF_REPLY_NODE,
      context: { messageType: "PRIVATE_COMMENT_REPLY" },
    });
    expect(getCommentId(withoutComment)).toBeUndefined();
  });
});

describe("getText", () => {
  test("replies: '<author> in <post title>' with the comment preview", () => {
    expect(getText(node(REPLY_NODE))).toEqual({
      title: "alice in Bun 1.4 is out",
      body: "Great point! u/hydra_user you should try it",
    });
  });

  test("mentions: Reddit's own title and body", () => {
    expect(getText(node(LONE_MENTION_NODE))).toEqual({
      title: "u/bob mentioned you in r/typescript",
      body: "cc u/hydra_user",
    });
  });

  test("missing preview is an empty body; missing everything is undefined", () => {
    const noPreview = node({
      ...REPLY_NODE,
      comment: { id: "t1_x", authorInfo: { displayName: "alice" } },
    });
    expect(getText(noPreview)).toEqual({ title: "alice in Bun 1.4 is out", body: "" });
    const bare = node({ id: "n", sentAt: "2026-11-10T00:00:00.000000+0000", readAt: null });
    expect(getText(bare)).toBeUndefined();
    const titleOnly = node({ id: "n", sentAt: "2026-11-10T00:00:00Z", title: "Hi" });
    expect(getText(titleOnly)).toEqual({ title: "Hi", body: "" });
  });
});

describe("getReplies", () => {
  test("a reply that also mentions the user merges into one item (mention first)", () => {
    const replies = getReplies([node(MENTION_OF_REPLY_NODE), node(REPLY_NODE)]);
    expect(replies).toEqual([
      {
        itemId: "t1_abc123",
        unread: true,
        sentAt: parseTime(MENTION_OF_REPLY_NODE.sentAt),
        // The reply's text wins over the mention's.
        title: "alice in Bun 1.4 is out",
        body: "Great point! u/hydra_user you should try it",
      },
    ]);
  });

  test("merge in the other order keeps the reply text and the newest sentAt", () => {
    const replies = getReplies([node(REPLY_NODE), node(MENTION_OF_REPLY_NODE)]);
    expect(replies).toHaveLength(1);
    expect(replies[0]?.title).toBe("alice in Bun 1.4 is out");
    expect(replies[0]?.sentAt).toBe(parseTime(MENTION_OF_REPLY_NODE.sentAt));
  });

  test("merged item is unread only if every part is unread", () => {
    const replies = getReplies([
      node({ ...REPLY_NODE, readAt: "2026-11-10T12:00:00.000000+0000" }),
      node(MENTION_OF_REPLY_NODE),
    ]);
    expect(replies[0]?.unread).toBe(false);
  });

  test("a mention without a comment stands alone", () => {
    expect(getReplies([node(LONE_MENTION_NODE)])).toEqual([
      {
        itemId: "t1_def456",
        unread: false,
        sentAt: Date.parse("2026-11-10T10:30:00.000Z"),
        title: "u/bob mentioned you in r/typescript",
        body: "cc u/hydra_user",
      },
    ]);
  });
});

describe("toNotification", () => {
  test("nodes without id or sentAt are dropped, like v1's filter", () => {
    expect(toNotification(BROKEN_NODE)).toBeUndefined();
    expect(toNotification(null)).toBeUndefined();
    expect(toNotification({ id: "x" })).toBeUndefined();
  });

  test("wrongly typed fields are treated as absent", () => {
    const n = toNotification({
      id: "x",
      sentAt: "2026-11-10T00:00:00Z",
      readAt: 5,
      title: 3,
      comment: { id: 7, authorInfo: "nope" },
      context: { messageType: ["COMMENT_REPLY"] },
    });
    expect(n).toEqual({
      id: "x",
      sentAt: "2026-11-10T00:00:00Z",
      readAt: null,
      comment: {},
      context: {},
    });
  });
});

describe("parseInboxData", () => {
  test("the realistic first page", () => {
    const { data } = FULL_INBOX as { data: unknown };
    const parsed = parseInboxData(data);
    expect(parsed.replies).toEqual([
      {
        itemId: "t1_abc123",
        unread: true,
        sentAt: Date.parse("2026-11-10T11:58:01.456Z"),
        title: "alice in Bun 1.4 is out",
        body: "Great point! u/hydra_user you should try it",
      },
      {
        itemId: "t1_def456",
        unread: false,
        sentAt: Date.parse("2026-11-10T10:30:00.000Z"),
        title: "u/bob mentioned you in r/typescript",
        body: "cc u/hydra_user",
      },
      {
        itemId: "t1_ghi789",
        unread: true,
        sentAt: Date.parse("2026-11-09T22:15:30.500Z"),
        title: "carol in Locking issue",
        body: "WAL mode fixed it for me",
      },
    ]);
    expect(parsed.unreadCount).toBe(2);
  });

  test("an empty or edge-less inbox is fine", () => {
    const { data } = inboxResponse([]) as { data: unknown };
    expect(parseInboxData(data)).toEqual({ replies: [], unreadCount: 0 });
    expect(parseInboxData({ notificationInboxV2: {} })).toEqual({ replies: [], unreadCount: 0 });
    expect(
      parseInboxData({ notificationInboxV2: { elements: { edges: [null, { node: null }] } } }),
    ).toEqual({ replies: [], unreadCount: 0 });
  });

  test("notificationInboxV2 missing means session_dead", () => {
    for (const data of [NO_INBOX_RESPONSE.data, {}, null, "x"]) {
      let caught: unknown;
      try {
        parseInboxData(data);
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(RedditError);
      expect((caught as RedditError).kind).toBe("session_dead");
    }
  });
});
