/**
 * The five legacy AI routes (frozen app contract).
 * Their errors are text/plain: see isLegacyTextErrorPath in http/middleware.ts.
 */
import { embed, generateText, type LanguageModel } from "ai";

import { readJson } from "../../http/body";
import { clientIp } from "../../http/clientIp";
import type { App } from "../../types";
import type { EntitlementService, PostClassifier } from "../contracts";
import { type ClassifyOutcome, toClassifierPosts } from "./classifier";
import { type AiCallOutcome, AiCallError, type AiGateway, normalizeUsage } from "./gateway";
import { ASK_QUESTION_INSTRUCTIONS, askQuestionPrompt } from "./prompts/askQuestion";
import {
  SUMMARIZE_COMMENTS_INSTRUCTIONS,
  SUMMARIZE_POST_INSTRUCTIONS,
  summarizeCommentsPrompt,
  summarizePostPrompt,
} from "./prompts/summarize";
import type { AiModelFactory } from "./providers";
import type { ModelEntry } from "./registry";
import {
  askQuestionSchema,
  createEmbeddingSchema,
  filterPostsSchema,
  summarizeCommentsSchema,
  summarizePostDetailsSchema,
} from "./schemas";

/**
 * v1 sent summaries as raw text labelled application/json; the app reads them
 * with response.text(), so the honest content type changes nothing for it.
 */
const TEXT_PLAIN = { "Content-Type": "text/plain; charset=UTF-8" } as const;

/** The whole call's deadline: one attempt, one retry, and the retry backoff. */
export function totalTimeoutMs(entry: ModelEntry): number {
  return entry.timeoutMs * 2 + 2_000;
}

/** One text generation call; empty output is a 502 that still records usage. */
async function generate(
  model: LanguageModel,
  entry: ModelEntry,
  instructions: string,
  prompt: string,
  signal: AbortSignal,
  options: { allowEmpty?: boolean } = {},
): Promise<AiCallOutcome<string>> {
  const result = await generateText({
    model,
    instructions,
    prompt,
    maxRetries: 1,
    timeout: totalTimeoutMs(entry),
    abortSignal: signal,
    providerOptions: entry.providerOptions,
    ...(entry.maxOutputTokens === null ? {} : { maxOutputTokens: entry.maxOutputTokens }),
  });
  const usage = normalizeUsage(result.usage);
  const text = result.text.trim();
  if (text === "") {
    if (result.finishReason === "length") {
      throw new AiCallError("model output was truncated before any text", "truncated", usage);
    }
    if (!options.allowEmpty) {
      throw new AiCallError(`model returned no text (${result.finishReason})`, "empty", usage);
    }
    return { value: "", usage, status: "empty" };
  }
  return { value: text, usage, status: result.finishReason === "length" ? "truncated" : "ok" };
}

export interface AiRoutesOptions {
  gateway: AiGateway;
  models: AiModelFactory;
  entitlements: EntitlementService;
  /** Injected classifier, or null to build the default LlmPostClassifier on first use. */
  classifier: () => PostClassifier;
}

export function registerAiRoutes(app: App, options: AiRoutesOptions): void {
  const { gateway, models, entitlements } = options;
  const { registry } = gateway;

  app.post("/api/ai/summarizePostDetails", async (c) => {
    const body = await readJson(c, summarizePostDetailsSchema);
    const entry = registry.summarizePost;
    const model = models.languageModel(entry);
    const summary = await gateway.runAI(
      "summarizePost",
      { customerId: body.customerId, clientIp: clientIp(c), signal: c.req.raw.signal },
      ({ signal }) =>
        generate(
          model,
          entry,
          SUMMARIZE_POST_INSTRUCTIONS,
          summarizePostPrompt({
            subreddit: body.subreddit,
            title: body.postTitle,
            author: body.postAuthor,
            text: body.postText,
          }),
          signal,
        ),
    );
    return c.text(summary, 200, TEXT_PLAIN);
  });

  app.post("/api/ai/summarizeComments", async (c) => {
    const body = await readJson(c, summarizeCommentsSchema);
    const entry = registry.summarizeComments;
    const model = models.languageModel(entry);
    const summary = await gateway.runAI(
      "summarizeComments",
      { customerId: body.customerId, clientIp: clientIp(c), signal: c.req.raw.signal },
      ({ signal }) =>
        generate(
          model,
          entry,
          SUMMARIZE_COMMENTS_INSTRUCTIONS,
          summarizeCommentsPrompt({
            postTitle: body.postTitle,
            postAuthor: body.postAuthor,
            postSummary: body.postSummary,
            comments: body.comments,
          }),
          signal,
        ),
    );
    return c.text(summary, 200, TEXT_PLAIN);
  });

  app.post("/api/ai/filterPosts", async (c) => {
    const body = await readJson(c, filterPostsSchema);
    // Exactly the requested ids, each defaulting to false (shown).
    const decisions = new Map<string, boolean>(body.posts.map((p) => [p.id, false]));
    // Sensitivity 0 hides nothing whatever the scores, so there's nothing to ask the model.
    if (body.posts.length === 0 || body.filterDescription.trim() === "" || body.sensitivity === 0) {
      entitlements.requirePro(body.customerId);
      return c.json(Object.fromEntries(decisions));
    }
    const classifier = options.classifier();
    const hide = await gateway.runAI(
      "filterPosts",
      { customerId: body.customerId, clientIp: clientIp(c), signal: c.req.raw.signal },
      async ({ signal }) => {
        const outcome: ClassifyOutcome = await classifier.classify(
          {
            description: body.filterDescription,
            posts: toClassifierPosts(body.posts),
            ...(body.sensitivity == null ? {} : { sensitivity: body.sensitivity }),
          },
          signal,
        );
        return {
          value: outcome.hide,
          usage: outcome.usage ?? null,
          status: outcome.status ?? "ok",
          ...(outcome.degraded ? { degraded: outcome.degraded } : {}),
        };
      },
    );
    body.posts.forEach((post, index) => {
      if (hide.has(index)) decisions.set(post.id, true);
    });
    return c.json(Object.fromEntries(decisions));
  });

  app.post("/api/ai/askQuestion", async (c) => {
    const body = await readJson(c, askQuestionSchema);
    const entry = registry.answerDocs;
    const model = models.languageModel(entry);
    const markdown = await gateway.runAI(
      "answerDocs",
      { clientIp: clientIp(c), signal: c.req.raw.signal },
      ({ signal }) =>
        generate(
          model,
          entry,
          ASK_QUESTION_INSTRUCTIONS,
          askQuestionPrompt(body.question, body.docs),
          signal,
          // The prompt asks for an empty reply to vague questions; the app
          // shows no answer box for "".
          { allowEmpty: true },
        ),
    );
    return c.json({ markdown });
  });

  app.post("/api/ai/createEmbedding", async (c) => {
    const body = await readJson(c, createEmbeddingSchema);
    const entry = registry.embedQuery;
    const model = models.embeddingModel(entry);
    const embedding = await gateway.runAI(
      "embedQuery",
      { clientIp: clientIp(c), signal: c.req.raw.signal },
      async ({ signal }) => {
        const result = await embed({
          model,
          value: body.text,
          maxRetries: 1,
          abortSignal: AbortSignal.any([signal, AbortSignal.timeout(totalTimeoutMs(entry))]),
        });
        if (result.embedding.length === 0) {
          throw new AiCallError("embedding was empty", "empty", {
            inputTokens: result.usage.tokens,
            outputTokens: 0,
          });
        }
        return {
          value: result.embedding,
          usage: normalizeUsage({ inputTokens: result.usage.tokens, outputTokens: 0 }),
        };
      },
    );
    return c.json(embedding);
  });
}
