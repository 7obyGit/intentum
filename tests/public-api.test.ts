import { describe, expect, it } from "vitest";
import * as intentum from "../src/index.js";

describe("public API", () => {
  it("keeps the documented runtime exports available", () => {
    const exports = [
      "AutoProvider", "CodexProvider", "FileCache", "FlowRun", "FlowStoppedError", "Intelligence",
      "MemoryCache", "MockProvider", "OpenAICompatibleProvider", "ProviderError", "SchemaValidationError",
      "StructuredOutputError", "arraySchema", "booleanSchema", "createProvider", "defineSchema",
      "describeArguments", "enumSchema", "flow", "fromJsonSchema", "fromZod", "generateStructuredWithRepair",
      "getActiveFlow", "impl", "literalSchema", "llm", "modelForIntelligence", "nullableSchema",
      "numberSchema", "objectSchema", "parseIntelligence", "providerFromEnvironment", "recordSchema",
      "refineSchema", "resolveIntelligence", "retry", "runTask", "shim", "step", "stringSchema", "task",
      "tupleSchema", "unionSchema"
    ] as const;
    for (const name of exports) expect(intentum[name]).toBeDefined();
  });

  it("exposes the default model policy through the package entrypoint", () => {
    expect(intentum.DEFAULT_INTELLIGENCE).toBe("MEDIUM");
    expect(intentum.INTELLIGENCE_MODELS).toEqual({ LOW: "Luna Low", MEDIUM: "Luna High", HIGH: "Sol High" });
    expect(intentum.Intelligence).toEqual({ LOW: "LOW", MEDIUM: "MEDIUM", HIGH: "HIGH" });
  });
});
