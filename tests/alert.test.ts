import { describe, expect, test } from "bun:test";
import { ALERT_RETRY_AFTER_FAILURE_MS, DISCORD_MAX_CHARS, DiscordAlerter } from "../src/lib/alert";
import { createOutboundFetch } from "../src/lib/http";
import { captureLogger, fakeClock, fakeFetch, rejection } from "./helpers";

const WEBHOOK = "https://discord.test/api/webhooks/1/abc";

describe("DiscordAlerter", () => {
  test("posts, dedupes by key within the window, and truncates", async () => {
    const fetch = fakeFetch().on("POST", WEBHOOK, { status: 204 });
    const clock = fakeClock();
    const alerter = new DiscordAlerter({
      webhookUrl: WEBHOOK,
      fetch,
      clock,
      log: captureLogger(),
      windowMs: 60_000,
    });
    await alerter.alert("k", "first");
    await alerter.alert("k", "suppressed");
    await alerter.alert("other", "x".repeat(5000));
    clock.advance(60_000);
    await alerter.alert("k", "again");
    expect(fetch.calls.map((c) => JSON.parse(c.body!).content.slice(0, 6))).toEqual([
      "first",
      "xxxxxx",
      "again",
    ]);
    expect(JSON.parse(fetch.calls[1]!.body!).content.length).toBe(DISCORD_MAX_CHARS);
    expect(fetch.calls[0]!.init.timeoutMs).toBe(5000);
  });

  test("never throws", async () => {
    const log = captureLogger();
    const alerter = new DiscordAlerter({
      webhookUrl: WEBHOOK,
      fetch: fakeFetch().enqueue(new Error("network down")).enqueue({ status: 500 }),
      clock: fakeClock(),
      log,
    });
    await alerter.alert("a", "one");
    await alerter.alert("b", "two");
    expect(log.lines.filter((l) => l["msg"] === "discord alert failed")).toHaveLength(2);
  });

  test("a failed send does not suppress the key for the whole window", async () => {
    for (const failure of [new Error("discord blip"), { status: 503 }]) {
      const fetch = fakeFetch().enqueue(failure).enqueue({ status: 204 }).enqueue({ status: 204 });
      const clock = fakeClock();
      const alerter = new DiscordAlerter({
        webhookUrl: WEBHOOK,
        fetch,
        clock,
        log: captureLogger(),
      });
      await alerter.alert("poller-down", "t0"); // fails
      await alerter.alert("poller-down", "burst"); // still within the retry backoff
      expect(fetch.calls).toHaveLength(1);
      clock.advance(ALERT_RETRY_AFTER_FAILURE_MS);
      await alerter.alert("poller-down", "retried"); // delivered
      clock.advance(5 * 60_000);
      await alerter.alert("poller-down", "dedupe again"); // delivered one claims the window
      expect(fetch.calls.map((c) => JSON.parse(c.body!).content)).toEqual(["t0", "retried"]);
    }
  });
});

describe("createOutboundFetch", () => {
  test("enforces the timeout and passes the proxy option", async () => {
    const seen: RequestInit[] = [];
    const base = ((_url: string | URL | Request, init?: RequestInit) => {
      seen.push(init ?? {});
      return new Promise<Response>((resolve, reject) => {
        const t = setTimeout(() => resolve(new Response("late")), 200);
        init?.signal?.addEventListener("abort", () => {
          clearTimeout(t);
          reject(init.signal?.reason);
        });
      });
    }) as typeof fetch;
    const outbound = createOutboundFetch(base);
    expect(await rejection(outbound("https://x.test", { timeoutMs: 10 }))).toBeInstanceOf(Error);
    await outbound("https://x.test", { timeoutMs: 1000, proxy: "http://p:1" });
    expect((seen[1] as { proxy?: string }).proxy).toBe("http://p:1");
    expect("proxy" in seen[0]!).toBe(false);
  });
});
