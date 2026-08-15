import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DEFAULT_INTELLIGENCE, Intelligence, modelForIntelligence, parseIntelligence, resolveIntelligence } from "../src/model.js";
import {
  AutoProvider,
  CodexProvider,
  MockProvider,
  OpenAICompatibleProvider,
  ProviderError,
  createProvider,
  parseStructuredOutput,
  withProviderRetries
} from "../src/provider.js";
import { objectSchema, stringSchema } from "../src/schema.js";
import { StructuredOutputError } from "../src/types.js";

describe("providers", () => {
  it("defaults model selection to MEDIUM intelligence", async () => {
    const previousIntelligence = process.env.INTENTUM_INTELLIGENCE;
    const previousModel = process.env.INTENTUM_MODEL;
    delete process.env.INTENTUM_INTELLIGENCE;
    delete process.env.INTENTUM_MODEL;
    let body: Record<string, unknown> | undefined;
    try {
      const provider = new OpenAICompatibleProvider({
        apiKey: "test-key",
        fetch: async (_input, init) => {
          body = JSON.parse(String(init?.body)) as Record<string, unknown>;
          return new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] }), { status: 200 });
        }
      });
      await expect(provider.generateText({ prompt: "hello" })).resolves.toBe("ok");
      expect(DEFAULT_INTELLIGENCE).toBe("MEDIUM");
      expect(resolveIntelligence(undefined)).toBe("MEDIUM");
      expect(body?.model).toBe("Luna High");
    } finally {
      if (previousIntelligence === undefined) delete process.env.INTENTUM_INTELLIGENCE;
      else process.env.INTENTUM_INTELLIGENCE = previousIntelligence;
      if (previousModel === undefined) delete process.env.INTENTUM_MODEL;
      else process.env.INTENTUM_MODEL = previousModel;
    }
  });

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

  it("prefers an available Codex provider before local discovery", async () => {
    const directory = await mkdtemp(join(tmpdir(), "intentum-test-auto-codex-"));
    const command = join(directory, "codex.mjs");
    await writeFile(command, `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === "--version") { console.log("fake-codex 1"); process.exit(0); }
console.log(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "codex answer" } }));
`, "utf8");
    await chmod(command, 0o755);
    let localCompletions = 0;
    try {
      const provider = new AutoProvider({
        codex: { command, maxRetries: 0 },
        localBaseURLs: ["http://local.test/v1"],
        local: {
          fetch: async (input) => {
            if (String(input).endsWith("/models")) return new Response(JSON.stringify({ data: [] }), { status: 200 });
            localCompletions += 1;
            return new Response(JSON.stringify({ choices: [{ message: { content: "local answer" } }] }), { status: 200 });
          }
        }
      });
      await expect(provider.generateText({ prompt: "hello" })).resolves.toBe("codex answer");
      expect(localCompletions).toBe(0);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
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

  it("validates intelligence values and maps every tier", () => {
    expect(modelForIntelligence(Intelligence.LOW)).toBe("Luna Low");
    expect(modelForIntelligence(Intelligence.MEDIUM)).toBe("Luna High");
    expect(modelForIntelligence(Intelligence.HIGH)).toBe("Sol High");
    expect(parseIntelligence(undefined)).toBeUndefined();
    expect(parseIntelligence("")).toBeUndefined();
    expect(resolveIntelligence("HIGH")).toBe("HIGH");
    expect(() => parseIntelligence("high")).toThrow("Invalid intelligence");
  });

  it("sends system prompts, image parts, and configured request options", async () => {
    let body: Record<string, any> | undefined;
    const provider = new OpenAICompatibleProvider({
      apiKey: "test-key",
      baseURL: "https://example.test/v1/",
      model: "custom-model",
      fetch: async (_input, init) => {
        body = JSON.parse(String(init?.body)) as Record<string, any>;
        return new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] }), { status: 200 });
      }
    });
    await expect(provider.generateText({
      prompt: "describe",
      system: "be concise",
      images: [{ data: "aGVsbG8=", mimeType: "image/jpeg", detail: "high" }]
    })).resolves.toBe("ok");
    expect(body?.messages).toEqual([
      { role: "system", content: "be concise" },
      {
        role: "user",
        content: [
          { type: "text", text: "describe" },
          { type: "image_url", image_url: { url: "data:image/jpeg;base64,aGVsbG8=", detail: "high" } }
        ]
      }
    ]);
  });

  it("rejects missing credentials, missing content, and missing structured schemas", async () => {
    const unauthenticated = new OpenAICompatibleProvider({ fetch: async () => new Response() });
    await expect(unauthenticated.generateText({ prompt: "hello" })).rejects.toMatchObject({ code: "AUTH", retryable: false });
    const malformed = new OpenAICompatibleProvider({
      apiKey: "test-key",
      fetch: async () => new Response(JSON.stringify({ choices: [{}] }), { status: 200 })
    });
    await expect(malformed.generateText({ prompt: "hello" })).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
    const provider = new OpenAICompatibleProvider({ apiKey: "test-key", fetch: async () => new Response() });
    await expect(provider.generateStructured({ prompt: "hello" })).rejects.toThrow("schema is required");
  });

  it("preserves HTTP metadata and retries rate limits", async () => {
    let calls = 0;
    const provider = new OpenAICompatibleProvider({
      apiKey: "test-key",
      maxRetries: 1,
      retryDelayMs: 0,
      retryJitter: 0,
      fetch: async () => {
        calls += 1;
        return new Response(JSON.stringify({ error: { message: "slow down" } }), {
          status: 429,
          headers: { "retry-after": "0", "x-request-id": "request-429" }
        });
      }
    });
    await expect(provider.generateText({ prompt: "hello" })).rejects.toMatchObject({
      code: "RATE_LIMIT",
      retryable: true,
      status: 429,
      requestId: "request-429",
      retryAfterMs: 0
    });
    expect(calls).toBe(2);
  });

  it("normalizes retryable failures and stops when aborted", async () => {
    let calls = 0;
    await expect(withProviderRetries("test", { maxRetries: 1, retryDelayMs: 0, retryJitter: 0 }, undefined, async () => {
      calls += 1;
      throw new Error("socket reset");
    })).rejects.toMatchObject({ code: "NETWORK", provider: "test", retryable: true });
    expect(calls).toBe(2);

    const controller = new AbortController();
    controller.abort(new Error("cancelled"));
    calls = 0;
    await expect(withProviderRetries("test", { maxRetries: 5, retryDelayMs: 0 }, controller.signal, async () => {
      calls += 1;
      return "never";
    })).rejects.toThrow("cancelled");
    expect(calls).toBe(0);
  });

  it("does not let telemetry callback failures break successful responses", async () => {
    const provider = new OpenAICompatibleProvider({
      apiKey: "test-key",
      onResponse: () => { throw new Error("telemetry down"); },
      fetch: async () => new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] }), { status: 200 })
    });
    await expect(provider.generateText({ prompt: "hello" })).resolves.toBe("ok");
  });

  it("falls back from an unavailable Codex to a configured cloud provider", async () => {
    const provider = new AutoProvider({
      codex: { command: "intentum-command-that-does-not-exist" },
      localBaseURLs: [],
      openai: {
        apiKey: "configured-key",
        fetch: async () => new Response(JSON.stringify({ choices: [{ message: { content: "cloud answer" } }] }), { status: 200 })
      }
    });
    await expect(provider.generateText({ prompt: "hello" })).resolves.toBe("cloud answer");
  });

  it("caches the active auto-detected provider after the first successful call", async () => {
    let probes = 0;
    let completions = 0;
    const fetch: typeof globalThis.fetch = async (input) => {
      if (String(input).endsWith("/models")) {
        probes += 1;
        return new Response(JSON.stringify({ data: [] }), { status: 200 });
      }
      completions += 1;
      return new Response(JSON.stringify({ choices: [{ message: { content: `answer-${completions}` } }] }), { status: 200 });
    };
    const provider = new AutoProvider({
      codex: { command: "intentum-command-that-does-not-exist" },
      localBaseURLs: ["http://local.test/v1"],
      local: { fetch, allowAnonymous: true, maxRetries: 0 }
    });
    await expect(provider.generateText({ prompt: "one" })).resolves.toBe("answer-1");
    await expect(provider.generateText({ prompt: "two" })).resolves.toBe("answer-2");
    expect(probes).toBe(1);
    expect(completions).toBe(2);
  });

  it("fails over from a previously active local provider when it becomes unavailable", async () => {
    let localCompletions = 0;
    const localFetch: typeof globalThis.fetch = async (input) => {
      if (String(input).endsWith("/models")) return new Response(JSON.stringify({ data: [] }), { status: 200 });
      localCompletions += 1;
      if (localCompletions > 1) throw new Error("local server stopped");
      return new Response(JSON.stringify({ choices: [{ message: { content: "local answer" } }] }), { status: 200 });
    };
    const provider = new AutoProvider({
      codex: { command: "intentum-command-that-does-not-exist" },
      localBaseURLs: ["http://local.test/v1"],
      local: { fetch: localFetch, maxRetries: 0 },
      openai: {
        apiKey: "configured-key",
        maxRetries: 0,
        fetch: async () => new Response(JSON.stringify({ choices: [{ message: { content: "cloud answer" } }] }), { status: 200 })
      }
    });
    await expect(provider.generateText({ prompt: "one" })).resolves.toBe("local answer");
    await expect(provider.generateText({ prompt: "two" })).resolves.toBe("cloud answer");
  });

  it("reports when automatic discovery has no candidates", async () => {
    const previousApiKey = process.env.INTENTUM_API_KEY;
    const previousOpenAiKey = process.env.OPENAI_API_KEY;
    delete process.env.INTENTUM_API_KEY;
    delete process.env.OPENAI_API_KEY;
    try {
      const provider = new AutoProvider({ codex: { command: "intentum-command-that-does-not-exist" }, localBaseURLs: [] });
      await expect(provider.generateText({ prompt: "hello" })).rejects.toMatchObject({ provider: "auto", code: "UNAVAILABLE" });
    } finally {
      if (previousApiKey === undefined) delete process.env.INTENTUM_API_KEY;
      else process.env.INTENTUM_API_KEY = previousApiKey;
      if (previousOpenAiKey === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = previousOpenAiKey;
    }
  });

  it("creates explicit provider choices and validates structured output", async () => {
    const schema = objectSchema("Answer", { value: stringSchema() });
    const local = createProvider({ provider: "local", local: { baseURL: "http://local.test/v1", fetch: async () => new Response(JSON.stringify({ choices: [{ message: { content: "local" } }] }), { status: 200 }) } });
    await expect(local.generateText({ prompt: "hello" })).resolves.toBe("local");
    const openai = createProvider({ provider: "openai", openai: { apiKey: "key", fetch: async () => new Response(JSON.stringify({ choices: [{ message: { content: '{\"value\":\"ok\"}' } }] }), { status: 200 }) } });
    await expect(openai.generateStructured({ prompt: "hello", schema })).resolves.toEqual({ value: "ok" });
    const mock = new MockProvider({ text: "mock", structured: { value: "mocked" } });
    await expect(mock.generateText({ prompt: "hello" })).resolves.toBe("mock");
    await expect(mock.generateStructured({ prompt: "hello", schema })).resolves.toEqual({ value: "mocked" });
    await expect(mock.generateStructured({ prompt: "hello" })).rejects.toThrow("schema is required");
  });

  it("wraps invalid structured content with the original response", () => {
    const schema = objectSchema("Answer", { value: stringSchema() });
    expect(() => parseStructuredOutput(schema, "not-json")).toThrow(StructuredOutputError);
    try {
      parseStructuredOutput(schema, "not-json");
    } catch (error) {
      expect(error).toMatchObject({ schemaName: "Answer", rawOutput: "not-json" });
    }
  });

  it("runs Codex JSON events, structured output files, and image materialization", async () => {
    const directory = await mkdtemp(join(tmpdir(), "intentum-test-codex-"));
    const command = join(directory, "fake-codex.mjs");
    await writeFile(command, `#!/usr/bin/env node
import { writeFileSync } from "node:fs";
const args = process.argv.slice(2);
const outputIndex = args.indexOf("--output-last-message");
if (outputIndex >= 0) writeFileSync(args[outputIndex + 1], JSON.stringify({ value: "structured" }));
console.log(JSON.stringify({ type: "thread.started", thread_id: "thread-1" }));
console.log(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "text output" } }));
`, "utf8");
    await chmod(command, 0o755);
    try {
      const provider = new CodexProvider({ command, maxRetries: 0, timeoutMs: 2_000 });
      await expect(provider.generateText({ prompt: "hello" })).resolves.toBe("text output");
      const schema = objectSchema("Answer", { value: stringSchema() });
      await expect(provider.generateStructured({ prompt: "hello", schema, images: [{ data: "aGVsbG8=", mimeType: "image/png" }] })).resolves.toEqual({ value: "structured" });
      await expect(provider.runTask("task")).resolves.toMatchObject({ output: "text output", returncode: 0, threadId: "thread-1" });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("maps missing and non-zero Codex commands to typed errors", async () => {
    const missing = new CodexProvider({ command: "intentum-command-that-does-not-exist", maxRetries: 0 });
    await expect(missing.generateText({ prompt: "hello" })).rejects.toMatchObject({ code: "UNAVAILABLE", retryable: false });
    const directory = await mkdtemp(join(tmpdir(), "intentum-test-codex-fail-"));
    const command = join(directory, "fail.mjs");
    await writeFile(command, "#!/usr/bin/env node\nconsole.error('failure'); process.exit(7);\n", "utf8");
    await chmod(command, 0o755);
    try {
      const failed = new CodexProvider({ command, maxRetries: 0 });
      await expect(failed.generateText({ prompt: "hello" })).rejects.toMatchObject({ code: "COMMAND_FAILED", retryable: true });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
