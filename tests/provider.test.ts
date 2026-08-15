import { describe, expect, it } from "vitest";
import { AutoProvider, OpenAICompatibleProvider, ProviderError } from "../src/provider.js";

describe("providers", () => {
  it("retries transient OpenAI-compatible failures with backoff controls", async () => {
    let calls = 0;
    const provider = new OpenAICompatibleProvider({
      apiKey: "test-key",
      maxRetries: 1,
      retryDelayMs: 0,
      retryJitter: 0,
      fetch: async () => {
        calls += 1;
        if (calls === 1) return new Response(JSON.stringify({ error: { message: "busy" } }), { status: 503 });
        return new Response(JSON.stringify({ choices: [{ message: { content: "recovered" } }] }), { status: 200 });
      }
    });
    await expect(provider.generateText({ prompt: "hello" })).resolves.toBe("recovered");
    expect(calls).toBe(2);
  });

  it("does not retry permanent provider failures", async () => {
    let calls = 0;
    const provider = new OpenAICompatibleProvider({
      apiKey: "test-key",
      maxRetries: 3,
      retryDelayMs: 0,
      fetch: async () => {
        calls += 1;
        return new Response(JSON.stringify({ error: { message: "bad request" } }), { status: 400 });
      }
    });
    await expect(provider.generateText({ prompt: "hello" })).rejects.toMatchObject({
      code: "HTTP",
      retryable: false
    } satisfies Partial<ProviderError>);
    expect(calls).toBe(1);
  });

  it("maps intelligence levels to the requested model", async () => {
    let body: Record<string, unknown> | undefined;
    let metadata: { usage?: { promptTokens?: number }; finishReason?: string } | undefined;
    const provider = new OpenAICompatibleProvider({
      apiKey: "test-key",
      intelligence: "MEDIUM",
      onResponse: (value) => { metadata = value; },
      fetch: async (_input, init) => {
        body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return new Response(JSON.stringify({
          choices: [{ message: { content: "ok" }, finish_reason: "stop" }],
          usage: { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5 }
        }), { status: 200, headers: { "x-request-id": "request-1" } });
      }
    });
    await expect(provider.generateText({ prompt: "hello" })).resolves.toBe("ok");
    expect(body?.model).toBe("Luna High");
    expect(metadata).toMatchObject({ usage: { promptTokens: 2 }, finishReason: "stop" });
  });

  it("accepts segmented content and reports refusals without retrying", async () => {
    let segmentedCalls = 0;
    const segmented = new OpenAICompatibleProvider({
      apiKey: "test-key",
      fetch: async () => {
        segmentedCalls += 1;
        return new Response(JSON.stringify({ choices: [{ message: { content: [{ text: "part " }, { text: "one" }] } }] }), { status: 200 });
      }
    });
    await expect(segmented.generateText({ prompt: "hello" })).resolves.toBe("part one");
    expect(segmentedCalls).toBe(1);

    let refusalCalls = 0;
    const refusal = new OpenAICompatibleProvider({
      apiKey: "test-key",
      maxRetries: 3,
      retryDelayMs: 0,
      fetch: async () => {
        refusalCalls += 1;
        return new Response(JSON.stringify({ choices: [{ message: { refusal: "not allowed" } }] }), { status: 200 });
      }
    });
    await expect(refusal.generateText({ prompt: "hello" })).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
    expect(refusalCalls).toBe(1);
  });

  it("prefers a reachable local model after Codex is unavailable", async () => {
    let completionCalls = 0;
    const fetch: typeof globalThis.fetch = async (input) => {
      if (String(input).endsWith("/models")) return new Response(JSON.stringify({ data: [] }), { status: 200 });
      completionCalls += 1;
      return new Response(JSON.stringify({ choices: [{ message: { content: "local answer" } }] }), { status: 200 });
    };
    const provider = new AutoProvider({
      codex: { command: "intentum-command-that-does-not-exist" },
      localBaseURLs: ["http://local.test/v1"],
      local: { fetch, model: "local-model", timeoutMs: 1_000, maxRetries: 0 }
    });
    await expect(provider.generateText({ prompt: "hello" })).resolves.toBe("local answer");
    expect(completionCalls).toBe(1);
  });

  it("reports request timeouts as typed provider errors", async () => {
    const provider = new OpenAICompatibleProvider({
      apiKey: "test-key",
      timeoutMs: 5,
      maxRetries: 0,
      fetch: async (_input, init) => new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      })
    });
    await expect(provider.generateText({ prompt: "hello" })).rejects.toMatchObject({
      code: "TIMEOUT",
      retryable: true
    });
  });
});
