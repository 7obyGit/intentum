import { describe, expect, it } from "vitest";
import { generateStructuredWithRepair, llm } from "../src/llm.js";
import { MockProvider, OpenAICompatibleProvider } from "../src/provider.js";
import { enumSchema, numberSchema, objectSchema, stringSchema } from "../src/schema.js";
import { StructuredOutputError } from "../src/types.js";
import type { GenerateRequest } from "../src/types.js";

describe("llm", () => {
  it("returns schema-validated structured output", async () => {
    const schema = objectSchema("Greeting", { message: stringSchema() });
    const greet = llm<[string], { message: string }>({
      schema,
      provider: new MockProvider({ structured: { message: "hello Ada" } }),
      prompt: ({ args }) => `Greet ${args[0]}`
    });
    await expect(greet("Ada")).resolves.toEqual({ message: "hello Ada" });
  });

  it("uses native JSON schema response format for OpenAI-compatible providers", async () => {
    let requestBody: Record<string, unknown> | undefined;
    const provider = new OpenAICompatibleProvider({
      apiKey: "test-key",
      fetch: async (_input, init) => {
        requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return new Response(JSON.stringify({ choices: [{ message: { content: '{"message":"ok"}' } }] }), { status: 200 });
      }
    });
    const schema = objectSchema("Greeting", { message: stringSchema() });
    await expect(provider.generateStructured({ prompt: "say hello", schema })).resolves.toEqual({ message: "ok" });
    expect(requestBody?.response_format).toMatchObject({ type: "json_schema" });
  });

  it("repairs invalid structured output using path-aware validation feedback", async () => {
    let calls = 0;
    const schema = objectSchema("Decision", {
      action: enumSchema("Action", ["allow", "deny"] as const),
      reason: stringSchema("Reason", { minLength: 3 })
    });
    const decide = llm<[], { action: "allow" | "deny"; reason: string }>({
      schema,
      provider: new MockProvider({
        structured: (request: GenerateRequest<unknown>) => {
          calls += 1;
          if (calls === 1) return { action: "maybe", reason: "x" };
          expect(request.prompt).toContain("$.action");
          expect(request.prompt).toContain("<invalid-output>");
          expect(request.prompt).toContain("maybe");
          expect(request.prompt).toContain("Return only corrected JSON");
          return { action: "allow", reason: "safe" };
        }
      }),
      prompt: () => "Decide whether the request should be allowed."
    });
    await expect(decide()).resolves.toEqual({ action: "allow", reason: "safe" });
    expect(calls).toBe(2);
  });

  it("stops after the configured number of structured repair attempts", async () => {
    const schema = objectSchema("Answer", { value: numberSchema() });
    const answer = llm<[], { value: number }>({
      schema,
      repair: { maxAttempts: 2 },
      provider: new MockProvider({ structured: { value: "not a number" } }),
      prompt: () => "Return an answer."
    });
    await expect(answer()).rejects.toThrow("$.value");
  });

  it("honors providerOptions when no provider instance is injected", async () => {
    const answer = llm<[], string>({
      providerOptions: {
        provider: "openai",
        openai: {
          apiKey: "test-key",
          fetch: async () => new Response(JSON.stringify({ choices: [{ message: { content: "configured" } }] }), { status: 200 })
        }
      },
      prompt: () => "Return a word."
    });
    await expect(answer()).resolves.toBe("configured");
  });

  it("builds prompts with display arguments and combines discovered and custom images", async () => {
    let request: GenerateRequest<never> | undefined;
    const answer = llm<[string], string>({
      provider: new MockProvider({ text: (value) => {
        request = value;
        return "ok";
      } }),
      prompt: ({ args, displayArgs, files }) => `${args[0]}|${displayArgs[0]}|${files.length}`,
      images: async () => [{ data: "CUSTOM", mimeType: "image/jpeg" }]
    });
    await expect(answer("data:image/png;base64,QUJD")).resolves.toBe("ok");
    expect(request).toMatchObject({
      prompt: "data:image/png;base64,QUJD|<image data>|0",
      images: [
        { data: "QUJD", mimeType: "image/png" },
        { data: "CUSTOM", mimeType: "image/jpeg" }
      ]
    });
  });

  it("returns text directly when no output schema is provided", async () => {
    const answer = llm<[], string>({ provider: new MockProvider({ text: "plain" }) });
    await expect(answer()).resolves.toBe("plain");
  });

  it("does not retry unrelated provider errors", async () => {
    let calls = 0;
    const schema = objectSchema("Answer", { value: stringSchema() });
    const provider = new MockProvider({ structured: () => {
      calls += 1;
      throw new Error("provider unavailable");
    } });
    await expect(generateStructuredWithRepair(provider, { prompt: "answer", schema })).rejects.toThrow("provider unavailable");
    expect(calls).toBe(1);
  });

  it("repairs syntax errors and can omit untrusted invalid output", async () => {
    let calls = 0;
    const schema = objectSchema("Answer", { value: stringSchema() });
    const provider = {
      async generateText(): Promise<string> { return "unused"; },
      async generateStructured<T>(request: GenerateRequest<T>): Promise<T> {
        calls += 1;
        if (calls === 1) throw new StructuredOutputError("Answer", "x".repeat(2_000), new SyntaxError("Unexpected token"));
        expect(request.prompt).toContain("Unexpected token");
        expect(request.prompt).not.toContain("<invalid-output>");
        expect(request.prompt).toContain("Correct it and try again");
        return { value: "fixed" } as T;
      }
    };
    await expect(generateStructuredWithRepair(provider, { prompt: "answer", schema }, {
      maxAttempts: 2,
      maxErrorCharacters: 600,
      includeInvalidOutput: false
    })).resolves.toEqual({ value: "fixed" });
    expect(calls).toBe(2);
  });

  it("rejects structured repair calls without schemas", async () => {
    const provider = new MockProvider({ structured: { value: "ignored" } });
    await expect(generateStructuredWithRepair(provider, { prompt: "answer" })).rejects.toThrow("schema is required");
  });

  it("forwards intelligence to an explicitly selected local provider", async () => {
    let body: Record<string, unknown> | undefined;
    const answer = llm<[], string>({
      intelligence: "HIGH",
      providerOptions: {
        provider: "local",
        local: {
          fetch: async (_input, init) => {
            body = JSON.parse(String(init?.body)) as Record<string, unknown>;
            return new Response(JSON.stringify({ choices: [{ message: { content: "high" } }] }), { status: 200 });
          }
        }
      }
    });
    await expect(answer()).resolves.toBe("high");
    expect(body?.model).toBe("Sol High");
  });
});
