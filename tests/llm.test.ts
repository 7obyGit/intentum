import { describe, expect, it } from "vitest";
import { llm } from "../src/llm.js";
import { MockProvider, OpenAICompatibleProvider } from "../src/provider.js";
import { objectSchema, stringSchema } from "../src/schema.js";

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
});
