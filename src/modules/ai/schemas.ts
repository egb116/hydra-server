/**
 * Request bodies of the five legacy AI routes. Field names and required-ness
 * are v1's (routes/ai/*.ts). The .max() bounds mirror the app's own
 * truncation (APP:api/AI.ts) with headroom.
 */
import { z } from "zod";
import { customerIdSchema } from "../../http/validation";

/** Same rule as every other customerId in the API. */
export const customerIdField = customerIdSchema;

export const LIMITS = {
  subreddit: 128,
  /** Reddit titles are at most 300 characters. */
  title: 1_000,
  author: 128,
  /** The app sends post.text.slice(0, 15_000). */
  postText: 16_000,
  /**
   * The app sends postSummary.slice(0, 15_000) today, but builds before
   * 2026-08 sent it unsliced (and it can be the raw post text), so longer
   * values are truncated rather than rejected.
   */
  postSummary: 16_000,
  /** The app sends the top 5 comments, each comment.text.slice(0, 3_000). */
  comments: 10,
  comment: 4_000,
  /** The app sends one listing page (Reddit returns at most 100 posts). */
  posts: 200,
  postId: 64,
  /** The app sends post.text.slice(0, 500). */
  filterPostText: 1_000,
  /** Free text the user types in settings; the app does not truncate it. */
  filterDescription: 10_000,
  /** The guide's search box; the app does not truncate it. */
  question: 2_000,
  /**
   * The app sends the top 3 documents (APP:pages/SettingsPage/Guide.tsx,
   * `.slice(0, 3)`; the largest is about 7.3k characters). Requests up to
   * `docs` x `doc` are accepted, but only the first `docsUsed` documents,
   * each cut to `docUsed` characters, reach the model. That bounds what one
   * free call can cost without breaking a future app build whose docs grow.
   */
  docs: 5,
  doc: 20_000,
  docsUsed: 3,
  docUsed: 10_000,
  embeddingText: 2_000,
} as const;

export const summarizePostDetailsSchema = z.object({
  customerId: customerIdField,
  subreddit: z.string().max(LIMITS.subreddit),
  postTitle: z.string().max(LIMITS.title),
  postAuthor: z.string().max(LIMITS.author),
  postText: z.string().max(LIMITS.postText),
});

export const summarizeCommentsSchema = z.object({
  customerId: customerIdField,
  comments: z.array(z.string().max(LIMITS.comment)).max(LIMITS.comments),
  postTitle: z.string().max(LIMITS.title),
  postAuthor: z.string().max(LIMITS.author),
  postSummary: z.string().transform((s) => s.slice(0, LIMITS.postSummary)),
});

export const filterPostSchema = z.object({
  id: z.string().min(1).max(LIMITS.postId),
  subreddit: z.string().max(LIMITS.subreddit),
  title: z.string().max(LIMITS.title),
  text: z.string().max(LIMITS.filterPostText).optional(),
});

export const filterPostsSchema = z.object({
  customerId: customerIdField,
  filterDescription: z.string().max(LIMITS.filterDescription),
  posts: z.array(filterPostSchema).max(LIMITS.posts),
});

export const askQuestionSchema = z.object({
  question: z.string().max(LIMITS.question),
  docs: z
    .array(z.string().max(LIMITS.doc))
    .max(LIMITS.docs)
    .transform((docs) => docs.slice(0, LIMITS.docsUsed).map((d) => d.slice(0, LIMITS.docUsed))),
});

export const createEmbeddingSchema = z.object({
  text: z.string().min(1).max(LIMITS.embeddingText),
});
