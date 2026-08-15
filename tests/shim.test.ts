import { describe, expect, it } from "vitest";
import { MockProvider } from "../src/provider.js";
import { repairPlanSchema, shim } from "../src/shim.js";
import type { GenerateRequest } from "../src/types.js";

describe("shim", () => {
  it("uses a retry repair plan for transient failures", async () => {
    let calls = 0;
    let repairPrompt = "";
    const wrapped = shim({
      name: "sometimesFails",
      parameters: ["value"],
      fn: (value: number) => {
        calls += 1;
        if (calls === 1) throw new Error("temporary failure");
        return value * 2;
      },
      provider: new MockProvider({
        structured: (request: GenerateRequest<unknown>) => {
          repairPrompt = request.prompt;
          return { strategy: "retry", explanation: "Transient error" };
        }
      })
    });
    await expect(wrapped(4)).resolves.toBe(8);
    expect(calls).toBe(2);
    expect(repairPrompt).toContain("temporary failure");
  });

  it("rewrites a failed implementation with normalized generated code", async () => {
    const wrapped = shim({
      name: "parseNumber",
      parameters: ["value"],
      fn: (_value: string) => { throw new Error("bad parser"); },
      provider: new MockProvider({
        structured: {
          strategy: "rewrite",
          body: "```javascript\nreturn Number(value) + 1;\n```",
          explanation: "Use numeric parsing"
        }
      })
    });
    await expect(wrapped("4")).resolves.toBe(5);
  });

  it("continues attempts when rewrite has no body and respects maxAttempts", async () => {
    let calls = 0;
    let plans = 0;
    const wrapped = shim({
      name: "recover",
      parameters: [],
      maxAttempts: 3,
      fn: () => {
        calls += 1;
        if (calls === 3) return "recovered";
        throw new Error("still broken");
      },
      provider: new MockProvider({
        structured: () => {
          plans += 1;
          return plans === 1 ? { strategy: "rewrite" } : { strategy: "retry" };
        }
      })
    });
    await expect(wrapped()).resolves.toBe("recovered");
    expect(calls).toBe(3);
    expect(plans).toBe(2);

    let providerCalls = 0;
    const noRetry = shim({
      name: "neverRecovers",
      parameters: [],
      maxAttempts: 0,
      fn: () => { throw new Error("permanent"); },
      provider: new MockProvider({ structured: () => { providerCalls += 1; return { strategy: "retry" }; } })
    });
    await expect(noRetry()).rejects.toThrow("permanent");
    expect(providerCalls).toBe(0);
  });

  it("supports custom repair prompts and validates repair plans", async () => {
    let seenArgs: readonly unknown[] = [];
    let seenError: unknown;
    const wrapped = shim({
      name: "customPrompt",
      parameters: ["value"],
      fn: (_value: string) => { throw new Error("oops"); },
      maxAttempts: 2,
      prompt: async (args, error) => {
        seenArgs = args;
        seenError = error;
        return "custom repair request";
      },
      provider: new MockProvider({ structured: { strategy: "retry" } })
    });
    await expect(wrapped("input")).rejects.toThrow("oops");
    expect(seenArgs).toEqual(["input"]);
    expect(seenError).toBeInstanceOf(Error);

    expect(repairPlanSchema.parse({ strategy: "retry", extra: true })).toEqual({ strategy: "retry" });
    expect(repairPlanSchema.parse({ strategy: "rewrite", body: "return 1;" })).toEqual({
      strategy: "rewrite",
      body: "return 1;"
    });
    expect(() => repairPlanSchema.parse({ strategy: "unknown" })).toThrow("Invalid repair strategy");
    expect(() => repairPlanSchema.parse({ strategy: "retry", body: 1 })).toThrow("Repair body");
  });

  it("uses providerOptions when no provider instance is injected", async () => {
    let calls = 0;
    const wrapped = shim({
      name: "configuredShim",
      parameters: [],
      fn: () => {
        calls += 1;
        if (calls === 1) throw new Error("transient");
        return "recovered";
      },
      providerOptions: {
        provider: "openai",
        openai: {
          apiKey: "test-key",
          fetch: async () => new Response(JSON.stringify({
            choices: [{ message: { content: JSON.stringify({ strategy: "retry" }) } }]
          }), { status: 200 })
        }
      }
    });
    await expect(wrapped()).resolves.toBe("recovered");
    expect(calls).toBe(2);
  });
});
