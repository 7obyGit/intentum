import { describe, expect, it } from "vitest";
import { impl } from "../src/impl.js";
import { MemoryCache } from "../src/cache.js";
import { MockProvider } from "../src/provider.js";
import { shim } from "../src/shim.js";

describe("generation and repair", () => {
  it("generates once and reuses a cache", async () => {
    let calls = 0;
    const fn = impl<[number], number>({
      name: "double",
      parameters: ["value"],
      description: "Return twice the value.",
      provider: new MockProvider({ text: () => { calls += 1; return "return value * 2;"; } }),
      cache: new MemoryCache()
    });
    await expect(fn(3)).resolves.toBe(6);
    await expect(fn(4)).resolves.toBe(8);
    expect(calls).toBe(1);
  });

  it("uses a structured rewrite plan after a failure", async () => {
    const parse = shim({
      name: "parse",
      parameters: ["value"],
      fn: (value: string) => JSON.parse(value) as unknown,
      provider: new MockProvider({ structured: { strategy: "rewrite", body: "return JSON.parse(value.replaceAll(\"'\", '\"'));" } })
    });
    await expect(parse("{'ok':true}")).resolves.toEqual({ ok: true });
  });

  it("supports explicit cache invalidation for changed generated behavior", async () => {
    const cache = new MemoryCache();
    let calls = 0;
    const make = (cacheVersion: string) => impl<[number], number>({
      name: "versioned",
      parameters: ["value"],
      description: "Return the value.",
      cacheVersion,
      cache,
      provider: new MockProvider({ text: () => { calls += 1; return "return value;"; } })
    });
    await expect(make("one")(1)).resolves.toBe(1);
    await expect(make("two")(1)).resolves.toBe(1);
    expect(calls).toBe(2);
  });

  it("coalesces concurrent generation and preserves the first call's arguments", async () => {
    let calls = 0;
    let prompt = "";
    const fn = impl<[number], number>({
      name: "coalesced",
      parameters: ["value"],
      description: "Return the value.",
      prompt: ([value]) => {
        prompt = `value=${value}`;
        return prompt;
      },
      provider: new MockProvider({
        text: async () => {
          calls += 1;
          await new Promise<void>((resolve) => setTimeout(resolve, 5));
          return "return value + 1;";
        }
      }),
      cache: false
    });
    await expect(Promise.all([fn(1), fn(2)])).resolves.toEqual([2, 3]);
    expect(calls).toBe(1);
    expect(prompt).toBe("value=1");
  });

  it("does not cache invalid generated code and can recover after a provider failure", async () => {
    let calls = 0;
    const cache = new MemoryCache();
    const fn = impl<[number], number>({
      name: "recoverable",
      parameters: ["value"],
      description: "Return the value.",
      cache,
      provider: new MockProvider({
        text: () => {
          calls += 1;
          if (calls === 1) return "return ; this is not valid JavaScript";
          return "return value * 3;";
        }
      })
    });
    await expect(fn(2)).rejects.toThrow();
    await expect(fn(2)).resolves.toBe(6);
    expect(calls).toBe(2);
  });

  it("can disable persistence while retaining per-function in-memory reuse", async () => {
    let calls = 0;
    const provider = new MockProvider({ text: () => { calls += 1; return "return value;"; } });
    const make = () => impl<[number], number>({
      name: "uncached",
      parameters: ["value"],
      description: "Return the value.",
      provider,
      cache: false
    });
    const first = make();
    await expect(first(1)).resolves.toBe(1);
    await expect(first(2)).resolves.toBe(2);
    await expect(make()(3)).resolves.toBe(3);
    expect(calls).toBe(2);
  });
});
