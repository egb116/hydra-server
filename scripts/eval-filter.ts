/**
 * Offline evaluation harness for filterPosts classifiers.
 *
 *   bun scripts/eval-filter.ts [--classifier llm|keyword] [--dir <folder>] [--case <text>] [--json]
 *
 * It loads every *.jsonl file in the fixtures folder (default
 * tests/fixtures/filter-eval; see its README), runs the chosen classifier on
 * each case, and prints the per-case results plus precision, recall, F1,
 * latency and estimated cost.
 *
 * The default "llm" classifier is the server's LlmPostClassifier over the
 * registry's filter model. It reads AI_PROVIDER, GROQ_API_KEY,
 * OPENAI_API_KEY, OPENAI_BASE_URL and AI_MODEL_FILTER from the environment,
 * and it makes real API calls, so only a human should run it. Bun loads
 * ./.env automatically, so keys there are used too. The "keyword" baseline
 * needs no network.
 *
 * This file is not a test and never runs under `bun test`.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { z } from "zod";
import type { AiProvider } from "../src/config";
import { createOutboundFetch } from "../src/lib/http";
import type { PostClassifier } from "../src/modules/contracts";
import {
  buildAiRegistry,
  costUsd,
  createProviderModelFactory,
  LlmPostClassifier,
  toClassifierPosts,
} from "../src/modules/ai";

export const DEFAULT_FIXTURE_DIR = resolve(import.meta.dir, "../tests/fixtures/filter-eval");

const evalPostSchema = z.object({
  id: z.string().min(1),
  title: z.string(),
  body: z.string().optional(),
  subreddit: z.string().optional(),
});

const evalCaseSchema = z
  .object({
    description: z.string().min(1),
    posts: z.array(evalPostSchema).min(1),
    hide: z.array(z.string()),
  })
  .superRefine((value, ctx) => {
    const ids = new Set(value.posts.map((p) => p.id));
    if (ids.size !== value.posts.length)
      ctx.addIssue({ code: "custom", message: "duplicate post id" });
    for (const id of value.hide) {
      if (!ids.has(id)) ctx.addIssue({ code: "custom", message: `hide id "${id}" is not a post` });
    }
  });

export type EvalPost = z.infer<typeof evalPostSchema>;

export interface EvalCase extends z.infer<typeof evalCaseSchema> {
  /** "file:line", for reporting. */
  source: string;
}

/** Parses one JSONL file. Blank lines are skipped; any bad line throws. */
export function parseCases(text: string, file: string): EvalCase[] {
  const cases: EvalCase[] = [];
  text.split(/\r?\n/).forEach((line, i) => {
    if (line.trim() === "") return;
    const source = `${file}:${i + 1}`;
    let json: unknown;
    try {
      json = JSON.parse(line);
    } catch (err) {
      throw new Error(
        `${source}: invalid JSON (${err instanceof Error ? err.message : String(err)})`,
        { cause: err },
      );
    }
    const parsed = evalCaseSchema.safeParse(json);
    if (!parsed.success) {
      throw new Error(`${source}: ${parsed.error.issues.map((issue) => issue.message).join("; ")}`);
    }
    cases.push({ ...parsed.data, source });
  });
  return cases;
}

export function loadCases(dir: string = DEFAULT_FIXTURE_DIR): EvalCase[] {
  return readdirSync(dir)
    .filter((name) => name.endsWith(".jsonl"))
    .sort()
    .flatMap((name) => parseCases(readFileSync(join(dir, name), "utf8"), name));
}

export interface CaseResult {
  source: string;
  description: string;
  truePositives: string[];
  falsePositives: string[];
  falseNegatives: string[];
  trueNegatives: number;
  latencyMs: number;
  costUsd: number;
  error: string | null;
}

export type Pricing = (usage: { inputTokens: number; outputTokens: number }) => number;

/** Runs one case. A classifier error counts as hiding nothing (the route fails open). */
export async function runCase(
  classifier: PostClassifier,
  evalCase: EvalCase,
  pricing: Pricing = () => 0,
  now: () => number = () => performance.now(),
): Promise<CaseResult> {
  const posts = toClassifierPosts(
    evalCase.posts.map((p) => ({
      title: p.title,
      ...(p.body === undefined ? {} : { text: p.body }),
      ...(p.subreddit === undefined ? {} : { subreddit: p.subreddit }),
    })),
  );
  const started = now();
  let hidden = new Set<number>();
  let cost = 0;
  let error: string | null = null;
  try {
    const result = await classifier.classify(
      { description: evalCase.description, posts },
      AbortSignal.timeout(120_000),
    );
    hidden = result.hide;
    if (result.usage) cost = pricing(result.usage);
  } catch (err) {
    error = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
  }
  const latencyMs = now() - started;
  const expected = new Set(evalCase.hide);
  const result: CaseResult = {
    source: evalCase.source,
    description: evalCase.description,
    truePositives: [],
    falsePositives: [],
    falseNegatives: [],
    trueNegatives: 0,
    latencyMs,
    costUsd: cost,
    error,
  };
  evalCase.posts.forEach((post, index) => {
    const predicted = hidden.has(index);
    const actual = expected.has(post.id);
    if (predicted && actual) result.truePositives.push(post.id);
    else if (predicted) result.falsePositives.push(post.id);
    else if (actual) result.falseNegatives.push(post.id);
    else result.trueNegatives++;
  });
  return result;
}

export interface Summary {
  cases: number;
  errors: number;
  perfectCases: number;
  truePositives: number;
  falsePositives: number;
  falseNegatives: number;
  trueNegatives: number;
  /** Micro-averaged over all posts. 1 when nothing was hidden and nothing should have been. */
  precision: number;
  recall: number;
  f1: number;
  latencyP50Ms: number;
  latencyP95Ms: number;
  totalCostUsd: number;
}

function percentile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) return 0;
  const index = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, index)] ?? 0;
}

export function summarize(results: readonly CaseResult[]): Summary {
  let tp = 0;
  let fp = 0;
  let fn = 0;
  let tn = 0;
  for (const r of results) {
    tp += r.truePositives.length;
    fp += r.falsePositives.length;
    fn += r.falseNegatives.length;
    tn += r.trueNegatives;
  }
  const precision = tp + fp === 0 ? 1 : tp / (tp + fp);
  const recall = tp + fn === 0 ? 1 : tp / (tp + fn);
  const f1 = precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall);
  const latencies = results.map((r) => r.latencyMs).sort((a, b) => a - b);
  return {
    cases: results.length,
    errors: results.filter((r) => r.error !== null).length,
    perfectCases: results.filter(
      (r) => r.error === null && r.falsePositives.length === 0 && r.falseNegatives.length === 0,
    ).length,
    truePositives: tp,
    falsePositives: fp,
    falseNegatives: fn,
    trueNegatives: tn,
    precision,
    recall,
    f1,
    latencyP50Ms: percentile(latencies, 50),
    latencyP95Ms: percentile(latencies, 95),
    totalCostUsd: results.reduce((sum, r) => sum + r.costUsd, 0),
  };
}

const STOPWORDS = new Set(
  "a an and or the of to in on for with about posts post that are is be any anything people their my i me want see dont don't not new".split(
    " ",
  ),
);

function words(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((w) => w.length > 2 && !STOPWORDS.has(w));
}

function stem(word: string): string {
  return word.slice(0, 5);
}

/**
 * An offline baseline: hides a post when its title, body or subreddit shares
 * a significant word (or its 5-letter stem) with the description. Useful to
 * check the harness without keys and as a floor to beat.
 */
export function keywordClassifier(): PostClassifier {
  return {
    name: "keyword",
    classify: async ({ description, posts }) => {
      const wanted = new Set(words(description).map(stem));
      const hide = new Set<number>();
      for (const post of posts) {
        const text = `${post.title} ${post.body ?? ""} ${post.subreddit ?? ""}`;
        if (words(text).some((w) => wanted.has(stem(w)))) hide.add(post.index);
      }
      return { hide };
    },
  };
}

interface LlmSetup {
  classifier: PostClassifier;
  pricing: Pricing;
  label: string;
}

function llmClassifierFromEnv(env: Record<string, string | undefined>): LlmSetup {
  const provider: AiProvider = env["AI_PROVIDER"] === "openai" ? "openai" : "groq";
  const ai = {
    provider,
    models: {
      summary: null,
      filter: env["AI_MODEL_FILTER"] ?? env["OPENAI_FILTER_MODEL"] ?? null,
      answer: null,
    },
  };
  const { registry, warnings } = buildAiRegistry(ai, "selfhost");
  for (const warning of warnings) process.stderr.write(`warning: ${warning}\n`);
  const entry = registry.filterPosts;
  const models = createProviderModelFactory(
    {
      groqApiKey: env["GROQ_API_KEY"] ?? null,
      openaiApiKey: env["OPENAI_API_KEY"] ?? null,
      openaiBaseUrl: env["OPENAI_BASE_URL"] ?? null,
    },
    createOutboundFetch(),
  );
  const classifier = new LlmPostClassifier({
    model: models.languageModel(entry),
    maxOutputTokens: entry.maxOutputTokens ?? 2_000,
    providerOptions: entry.providerOptions,
    timeoutMs: entry.timeoutMs * 2 + 2_000,
  });
  return {
    classifier,
    pricing: (usage) => costUsd(entry, usage.inputTokens, usage.outputTokens),
    label: `llm (${provider}: ${entry.modelId})`,
  };
}

interface Args {
  classifier: "llm" | "keyword";
  dir: string;
  filter: string | null;
  json: boolean;
}

export function parseArgs(argv: readonly string[]): Args {
  const args: Args = { classifier: "llm", dir: DEFAULT_FIXTURE_DIR, filter: null, json: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const value = (): string => {
      const next = argv[++i];
      if (next === undefined) throw new Error(`${arg} needs a value`);
      return next;
    };
    if (arg === "--classifier") {
      const kind = value();
      if (kind !== "llm" && kind !== "keyword") throw new Error(`unknown classifier "${kind}"`);
      args.classifier = kind;
    } else if (arg === "--dir") args.dir = resolve(value());
    else if (arg === "--case") args.filter = value().toLowerCase();
    else if (arg === "--json") args.json = true;
    else throw new Error(`unknown argument "${arg}"`);
  }
  return args;
}

const pct = (n: number) => `${(n * 100).toFixed(1)}%`;

function report(label: string, results: readonly CaseResult[], summary: Summary): string {
  const lines: string[] = [`classifier: ${label}`, ""];
  for (const r of results) {
    const ok = r.error === null && r.falsePositives.length === 0 && r.falseNegatives.length === 0;
    lines.push(
      `${ok ? "PASS" : "FAIL"}  ${r.source}  "${r.description}"  ${Math.round(r.latencyMs)}ms  $${r.costUsd.toFixed(6)}`,
    );
    if (r.error) lines.push(`      error: ${r.error}`);
    if (r.falsePositives.length > 0)
      lines.push(`      hid but should show: ${r.falsePositives.join(", ")}`);
    if (r.falseNegatives.length > 0)
      lines.push(`      showed but should hide: ${r.falseNegatives.join(", ")}`);
  }
  lines.push(
    "",
    `cases: ${summary.cases} (${summary.perfectCases} perfect, ${summary.errors} errors)`,
    `posts: TP ${summary.truePositives}, FP ${summary.falsePositives}, FN ${summary.falseNegatives}, TN ${summary.trueNegatives}`,
    `precision ${pct(summary.precision)}  recall ${pct(summary.recall)}  F1 ${pct(summary.f1)}`,
    `latency p50 ${Math.round(summary.latencyP50Ms)}ms  p95 ${Math.round(summary.latencyP95Ms)}ms`,
    `cost $${summary.totalCostUsd.toFixed(6)} total`,
  );
  return `${lines.join("\n")}\n`;
}

export async function main(argv: readonly string[]): Promise<number> {
  const args = parseArgs(argv);
  let cases = loadCases(args.dir);
  if (args.filter !== null) {
    const needle = args.filter;
    cases = cases.filter(
      (c) =>
        c.description.toLowerCase().includes(needle) || c.source.toLowerCase().includes(needle),
    );
  }
  if (cases.length === 0) {
    process.stderr.write("no cases matched\n");
    return 1;
  }
  const setup: LlmSetup =
    args.classifier === "keyword"
      ? { classifier: keywordClassifier(), pricing: () => 0, label: "keyword baseline" }
      : llmClassifierFromEnv(process.env);
  const results: CaseResult[] = [];
  // Sequential on purpose: latency numbers stay comparable and rate limits are not hit.
  for (const c of cases) results.push(await runCase(setup.classifier, c, setup.pricing));
  const summary = summarize(results);
  process.stdout.write(
    args.json
      ? `${JSON.stringify({ classifier: setup.label, results, summary }, null, 2)}\n`
      : report(setup.label, results, summary),
  );
  return summary.errors > 0 ? 2 : 0;
}

if (import.meta.main) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (err: unknown) => {
      process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
      process.exit(1);
    },
  );
}
