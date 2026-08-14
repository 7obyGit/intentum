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
});
