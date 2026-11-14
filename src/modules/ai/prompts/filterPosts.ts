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
