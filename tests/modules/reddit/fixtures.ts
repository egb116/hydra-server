/**
 * GetInboxNotificationFeedV2 responses shaped like Reddit's, based on the
 * fields v1 (tasks/CheckForMessages.ts) and the app (APP:api/gql/Inbox.ts)
 * read: data.notificationInboxV2.elements.{edges[].node, pageInfo}.
 */

export const REPLY_NODE = {
  __typename: "InboxNotification",
  id: "Tm90aWZpY2F0aW9uOjE=",
  title: "alice replied to your comment in r/bun",
  body: "Great point! u/hydra_user you should try it",
  sentAt: "2026-11-10T11:58:00.123000+0000",
  readAt: null,
  deeplinkUrl: "https://www.reddit.com/r/bun/comments/1xyzab/bun_14_is_out/abc123/",
  isHideNotifEligible: true,
  comment: {
    __typename: "Comment",
    id: "t1_abc123",
    content: { __typename: "Content", preview: "Great point! u/hydra_user you should try it" },
    authorInfo: { __typename: "Redditor", displayName: "alice" },
  },
  context: {
    __typename: "CommentReplyNotificationContext",
    messageType: "COMMENT_REPLY",
    post: { __typename: "SubredditPost", id: "t3_1xyzab", title: "Bun 1.4 is out" },
  },
} as const;

/** The same comment pings the user: Reddit sends a mention too, without the comment. */
export const MENTION_OF_REPLY_NODE = {
  __typename: "InboxNotification",
  id: "Tm90aWZpY2F0aW9uOjI=",
  title: "u/alice mentioned you in r/bun",
  body: "Great point! u/hydra_user you should try it",
  sentAt: "2026-11-10T11:58:01.456789+0000",
  readAt: null,
  deeplinkUrl: "https://www.reddit.com/r/bun/comments/1xyzab/bun_14_is_out/abc123/?context=3",
  comment: null,
  context: {
    __typename: "UsernameMentionNotificationContext",
    messageType: "USERNAME_MENTION",
    post: null,
  },
} as const;

/** A mention with no comment object at all; the comment id comes from the link. */
export const LONE_MENTION_NODE = {
  __typename: "InboxNotification",
  id: "Tm90aWZpY2F0aW9uOjM=",
  title: "u/bob mentioned you in r/typescript",
  body: "cc u/hydra_user",
  sentAt: "2026-11-10T10:30:00.000000+0000",
  readAt: "2026-11-10T10:45:00.000000+0000",
  deeplinkUrl:
    "https://www.reddit.com/r/typescript/comments/1qwert/some_slug/def456/?context=3#comment",
  comment: null,
  context: { messageType: "USERNAME_MENTION" },
} as const;

export const POST_REPLY_NODE = {
  __typename: "InboxNotification",
  id: "Tm90aWZpY2F0aW9uOjQ=",
  title: "carol replied to your post in r/sqlite",
  body: "WAL mode fixed it for me",
  sentAt: "2026-11-09T22:15:30.500000+0000",
  readAt: null,
  deeplinkUrl: "https://www.reddit.com/r/sqlite/comments/1asdfg/locking_issue/ghi789/",
  comment: {
    id: "t1_ghi789",
    content: { preview: "WAL mode fixed it for me" },
    authorInfo: { displayName: "carol" },
  },
  context: { messageType: "POST_REPLY", post: { id: "t3_1asdfg", title: "Locking issue" } },
} as const;

/** Reddit's own suggestions make up most of the feed; they're never notified. */
export const SUGGESTION_NODE = {
  __typename: "InboxNotification",
  id: "Tm90aWZpY2F0aW9uOjU=",
  title: "Trending in r/programming",
  body: "Why we rewrote our server in Bun",
  sentAt: "2026-11-10T09:00:00.000000+0000",
  readAt: null,
  deeplinkUrl: "https://www.reddit.com/r/programming/comments/1zxcvb/why_we_rewrote/",
  comment: null,
  context: { messageType: "TRENDING_POST", post: { id: "t3_1zxcvb", title: "Why we rewrote" } },
} as const;

/** No sentAt: v1 drops the node before parsing. */
export const BROKEN_NODE = {
  id: "Tm90aWZpY2F0aW9uOjY=",
  title: "broken",
  readAt: null,
  comment: { id: "t1_zzz999", authorInfo: { displayName: "dave" } },
  context: { messageType: "COMMENT_REPLY", post: { title: "x" } },
} as const;

export function inboxResponse(nodes: readonly unknown[]): unknown {
  return {
    data: {
      notificationInboxV2: {
        __typename: "NotificationInboxV2",
        elements: {
          __typename: "InboxNotificationConnection",
          edges: nodes.map((node) => ({ __typename: "InboxNotificationEdge", node })),
          pageInfo: {
            __typename: "PageInfo",
            hasNextPage: true,
            endCursor: "Y3Vyc29yOjUw",
          },
        },
      },
    },
  };
}

/** The realistic first page: a merged reply+mention, a lone mention, a post reply, noise. */
export const FULL_INBOX = inboxResponse([
  SUGGESTION_NODE,
  MENTION_OF_REPLY_NODE,
  REPLY_NODE,
  LONE_MENTION_NODE,
  BROKEN_NODE,
  POST_REPLY_NODE,
]);

/** A token issued for a very old session: Reddit answers, but with no inbox. */
export const NO_INBOX_RESPONSE = { data: { notificationInboxV2: null } };

export const PERSISTED_QUERY_NOT_FOUND = {
  errors: [
    { message: "PersistedQueryNotFound", extensions: { code: "PERSISTED_QUERY_NOT_FOUND" } },
  ],
};
