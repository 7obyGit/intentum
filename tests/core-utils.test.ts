import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { FileCache, MemoryCache } from "../src/cache.js";
import { compileBody, hashDefinition, normalizeGeneratedCode } from "../src/code.js";
import { describeArguments } from "../src/context.js";

describe("core utilities", () => {
  it("supports memory cache hits and misses", async () => {
    const cache = new MemoryCache();
    await expect(cache.get("missing")).resolves.toBeUndefined();
    await cache.set("key", "value");
    await expect(cache.get("key")).resolves.toBe("value");
    await cache.set("key", "updated");
    await expect(cache.get("key")).resolves.toBe("updated");
  });

  it("persists file cache values atomically and isolates keys", async () => {
    const directory = await mkdtemp(join(tmpdir(), "intentum-cache-test-"));
    try {
      const cache = new FileCache(directory);
      await expect(cache.get("missing")).resolves.toBeUndefined();
      await Promise.all([
        cache.set("same", "first"),
        cache.set("same", "second")
      ]);
      await expect(cache.get("same")).resolves.toMatch(/^(first|second)$/);
      await cache.set("other", "value");
      await expect(cache.get("other")).resolves.toBe("value");
      await expect(cache.get("same")).resolves.not.toBe("value");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("normalizes fenced and plain generated code", () => {
    expect(normalizeGeneratedCode("```javascript\nreturn value * 2;\n```")).toBe("return value * 2;");
    expect(normalizeGeneratedCode("```\nconst answer = 42;\n```")).toBe("const answer = 42;");
    expect(normalizeGeneratedCode("  return value;  ")).toBe("return value;");
    expect(normalizeGeneratedCode("return ```javascript\nvalue\n```\n")).toBe("value");
  });

  it("compiles async function bodies and preserves argument order", async () => {
    const fn = compileBody<[number, number], number>(["left", "right"], "return await Promise.resolve(left + right);");
    await expect(fn(2, 3)).resolves.toBe(5);
    const failing = compileBody<[], never>([], "throw new Error('generated failure');");
    await expect(failing()).rejects.toThrow("generated failure");
  });

  it("hashes stable definitions deterministically", () => {
    expect(hashDefinition({ b: 2, a: 1 })).toBe(hashDefinition({ b: 2, a: 1 }));
    expect(hashDefinition({ b: 2, a: 1 })).not.toBe(hashDefinition({ b: 2, a: 2 }));
    expect(hashDefinition({ value: "x" })).toMatch(/^[0-9a-f]{64}$/);
  });

  it("describes data URI and image-file arguments safely", async () => {
    const directory = await mkdtemp(join(tmpdir(), "intentum-context-test-"));
    const imagePath = join(directory, "sample.JPEG");
    try {
      await writeFile(imagePath, Buffer.from([1, 2, 3, 4]));
      const result = await describeArguments([
        "data:image/png;base64,QUJD",
        imagePath,
        "ordinary text"
      ]);
      expect(result.display).toEqual(["<image data>", "<image file: sample.JPEG>", "ordinary text"]);
      expect(result.images).toEqual([
        { data: "QUJD", mimeType: "image/png" },
        { data: "AQIDBA==", mimeType: "image/jpeg" }
      ]);
      expect(result.files).toEqual([imagePath]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("handles malformed image data, unreadable paths, empty values, and long strings", async () => {
    const unreadable = "/tmp/intentum-no-such-image.png";
    const longValue = "x".repeat(20);
    const result = await describeArguments([
      "data:image/png-no-comma",
      unreadable,
      "",
      longValue,
      42
    ], { maxFileCharacters: 5 });
    expect(result.images).toEqual([]);
    expect(result.files).toEqual([]);
    expect(result.display).toEqual([
      "<image data>",
      unreadable,
      "",
      longValue,
      42
    ]);
  });
});
