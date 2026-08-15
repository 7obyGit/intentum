import { describe, expect, it } from "vitest";
import { llm } from "../src/llm.js";
import { MockProvider, OpenAICompatibleProvider } from "../src/provider.js";
import { enumSchema, numberSchema, objectSchema, stringSchema } from "../src/schema.js";
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
});
