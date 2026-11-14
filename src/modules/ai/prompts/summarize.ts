/** Prompts for the two summary features. Wording follows v1's routes/ai/summarize*.ts. */
import { block, group, untrustedNotice } from "./delimit";

export interface PostForSummary {
  subreddit: string;
  title: string;
  author: string;
  text: string;
}

export const SUMMARIZE_POST_INSTRUCTIONS = [
  "You are a helpful assistant that summarizes Reddit posts. Provide a concise summary of the main points in one paragraph. If the user refers to themselves, use their username instead.",
  untrustedNotice("Reddit content (the post's subreddit, title, author and text)"),
  "Reply with the summary paragraph only.",
].join("\n\n");

export function summarizePostPrompt(post: PostForSummary): string {
  return group("post", [
    block("subreddit", post.subreddit),
    block("title", post.title),
    block("author", post.author),
    block("text", post.text),
  ]);
}

export interface CommentsForSummary {
  postTitle: string;
  postAuthor: string;
  /** The post summary, or the raw post text when there is none. */
  postSummary: string;
  comments: readonly string[];
}

export const SUMMARIZE_COMMENTS_INSTRUCTIONS = [
  'You are a helpful assistant that summarizes Reddit comments. Provide a concise summary of the main points, ideas, and opinions expressed in the comments in one paragraph. Do not refer to the comments by number. If the author is "AutoModerator", exclude their comment if the comment looks like template text.',
  untrustedNotice("Reddit content (a post and its top comments)"),
  "Reply with the summary paragraph only.",
].join("\n\n");

export function summarizeCommentsPrompt(input: CommentsForSummary): string {
  return [
    group("post", [
      block("title", input.postTitle),
      block("author", input.postAuthor),
      block("summary", input.postSummary),
    ]),
    group(
      "comments",
      input.comments.map((comment, i) => block("comment", comment, { n: i + 1 })),
    ),
  ].join("\n\n");
}
