import { compileBody, normalizeGeneratedCode } from "./code.js";
import { providerFromEnvironment, type ProviderOptions } from "./provider.js";
import { defineSchema, type OutputSchema } from "./schema.js";
import type { Awaitable, ModelProvider } from "./types.js";

export type RepairStrategy = "retry" | "rewrite";

export interface RepairPlan {
  readonly strategy: RepairStrategy;
  readonly body?: string;
  readonly explanation?: string;
}

const repairPlanSchema: OutputSchema<RepairPlan> = defineSchema("RepairPlan", {
  type: "object",
  properties: {
    strategy: { type: "string", enum: ["retry", "rewrite"] },
    body: { type: "string" },
    explanation: { type: "string" }
  },
  required: ["strategy"],
  additionalProperties: false
}, (value) => {
  if (typeof value !== "object" || value === null) throw new TypeError("Repair plan must be an object");
  const record = value as Record<string, unknown>;
  if (record.strategy !== "retry" && record.strategy !== "rewrite") throw new TypeError("Invalid repair strategy");
  if (record.body !== undefined && typeof record.body !== "string") throw new TypeError("Repair body must be a string");
  if (record.explanation !== undefined && typeof record.explanation !== "string") throw new TypeError("Repair explanation must be a string");
  return {
    strategy: record.strategy,
    ...(typeof record.body === "string" ? { body: record.body } : {}),
    ...(typeof record.explanation === "string" ? { explanation: record.explanation } : {})
  };
});

export interface ShimDefinition<Args extends readonly unknown[], Result> {
  readonly name: string;
  readonly parameters: readonly string[];
  readonly fn: (...args: Args) => Awaitable<Result>;
  readonly provider?: ModelProvider;
  readonly providerOptions?: ProviderOptions;
  readonly maxAttempts?: number;
  readonly prompt?: (args: Args, error: unknown) => Awaitable<string>;
}

/** Wrap a function with model-assisted retry or source replacement after a failure. */
export function shim<Args extends readonly unknown[], Result>(
  definition: ShimDefinition<Args, Result>
): (...args: Args) => Promise<Result> {
  const provider = definition.provider ?? providerFromEnvironment(definition.providerOptions);
  const maxAttempts = Math.max(1, definition.maxAttempts ?? 2);
  return async (...args: Args): Promise<Result> => {
    let lastError: unknown;
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      try {
        return await definition.fn(...args);
      } catch (error) {
        lastError = error;
        if (attempt === maxAttempts - 1) break;
        const prompt = await (definition.prompt?.(args, error) ?? [
          `Repair the function ${definition.name}.`,
          `Parameters: ${JSON.stringify(args)}`,
          `Error: ${error instanceof Error ? error.stack ?? error.message : String(error)}`,
          "Return a JSON repair plan. Prefer retry when the input may be transient; use rewrite with a JavaScript function body when the implementation is wrong."
        ].join("\n"));
        const plan = await provider.generateStructured({
          prompt,
          schema: repairPlanSchema,
          system: "You are a careful runtime repair assistant. Never hide an error with an unrelated result."
        });
        if (plan.strategy === "rewrite" && plan.body) {
          const replacement = compileBody<Args, Result>(definition.parameters, normalizeGeneratedCode(plan.body));
          return replacement(...args);
        }
      }
    }
    throw lastError;
  };
}

export { repairPlanSchema };
