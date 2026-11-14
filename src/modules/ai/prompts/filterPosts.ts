/**
 * The post-filter prompt. Posts are referred to by server-assigned indices,
 * never by their Reddit ids, so the model's output can only name posts that
 * were in the request.
 */
import type { ClassifierPost } from "../../contracts";
import { block, group, untrustedNotice } from "./delimit";

export const FILTER_INSTRUCTIONS = [
  "You are a helpful assistant that filters Reddit posts based on a user's description of the posts they do NOT want to see.",
  "The description is in the <filter_description> block. Each post is in a <post> block with a numeric index attribute.",
  "For each post, decide whether it matches the filter description and should be hidden. Be thorough and consider the subreddit, title and text of each post. If a post does not have enough information to make a determination, do not hide it.",
  untrustedNotice(
    "text: the filter description is written by the app's user, and the posts are written by Reddit users",
  ),
  'Respond with only a JSON object of the form {"hide": [<index>, ...]} listing the index of every post that should be hidden, for example {"hide": [0, 3]}. Respond {"hide": []} when no post matches.',
].join("\n\n");

export interface FilterPromptInput {
  description: string;
  posts: readonly ClassifierPost[];
}

/**
 * Decision-model state for a batch of posts: the reader's description once,
 * then each post with its server-assigned number (never its Reddit id).
 * Everything here is data; the questions (filterDecisionQuestion) are the
 * only instructions. Absent post fields are left out rather than sent empty.
 *
 * Measured on Jev (2026-11-14, 25-post pages): this layout matched one call
 * per post on 99.4% of decisions at about a third of the tokens and a third
 * of the latency. Repeating the description in every question instead was
 * clearly worse (it missed obvious matches).
 */
export function filterDecisionState(
  description: string,
  posts: readonly ClassifierPost[],
): { filter_description: string; posts: Record<string, string | number>[] } {
  return {
    filter_description: description,
    posts: posts.map((post) => {
      const entry: Record<string, string | number> = { number: post.index };
      if (post.subreddit !== undefined && post.subreddit !== "")
        entry["subreddit"] = post.subreddit;
      entry["title"] = post.title;
      if (post.body !== undefined && post.body !== "") entry["text"] = post.body;
      return entry;
    }),
  };
}

/** The question id for a post in a batch. */
export function filterQuestionId(post: Pick<ClassifierPost, "index">): string {
  return `post${post.index}`;
}

/**
 * The question for one post of a batch: does it match the reader's
 * description of posts they don't want to see? P(true) is compared to the
 * request's threshold.
 */
export function filterDecisionQuestion(post: Pick<ClassifierPost, "index">) {
  return {
    type: "boolean",
    instructions: `Does post number ${post.index} match the reader's filter_description (posts they do NOT want to see)? Judge only that post, using its subreddit, title and text.`,
    criteria: {
      true: "The post matches the description, so the reader would not want to see it.",
      false: "The post does not match the description, or there is not enough information to tell.",
    },
  } as const;
}

export function filterPostsPrompt(input: FilterPromptInput): string {
  const posts = input.posts.map((post) => {
    const parts: string[] = [];
    if (post.subreddit !== undefined) parts.push(block("subreddit", post.subreddit));
    parts.push(block("title", post.title));
    if (post.body !== undefined && post.body !== "") parts.push(block("text", post.body));
    return group("post", parts, { index: post.index });
  });
  return [block("filter_description", input.description), group("posts", posts)].join("\n\n");
}
