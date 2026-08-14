import { FileCache } from "./cache.js";
import { compileBody, hashDefinition, normalizeGeneratedCode } from "./code.js";
import { providerFromEnvironment, type ProviderOptions } from "./provider.js";
import type { Awaitable, Cache, ModelProvider } from "./types.js";

export interface ImplDefinition<Args extends readonly unknown[], Result> {
  readonly name: string;
  readonly parameters: readonly string[];
  readonly description: string;
  readonly returnType?: string;
  readonly prompt?: (args: Args) => Awaitable<string>;
  readonly provider?: ModelProvider;
  readonly providerOptions?: ProviderOptions;
  readonly cache?: Cache | false;
}

/** Generate a JavaScript function body from a declarative specification and cache it. */
export function impl<Args extends readonly unknown[], Result>(
  definition: ImplDefinition<Args, Result>
): (...args: Args) => Promise<Result> {
  const provider = definition.provider ?? providerFromEnvironment();
  const cache = definition.cache === false ? undefined : (definition.cache ?? new FileCache());
  const key = hashDefinition({
    name: definition.name,
    parameters: definition.parameters,
    description: definition.description,
    returnType: definition.returnType
  });
  let implementation: ((...args: Args) => Promise<Result>) | undefined;
  let loading: Promise<(...args: Args) => Promise<Result>> | undefined;

  const load = async (args: Args): Promise<((...args: Args) => Promise<Result>)> => {
    if (implementation) return implementation;
    if (!loading) {
      loading = (async () => {
        const cached = await cache?.get(key);
        const body = cached ?? normalizeGeneratedCode(await provider.generateText({
          prompt: await (definition.prompt?.(args) ?? buildPrompt(definition)),
          system: "Generate only the JavaScript function body. Do not include markdown fences or explanations."
        }));
        if (!cached) await cache?.set(key, body);
        implementation = compileBody<Args, Result>(definition.parameters, body);
        return implementation;
      })();
    }
    return loading;
  };
  return async (...args: Args): Promise<Result> => {
    const generated = await load(args);
    return generated(...args);
  };
}

function buildPrompt<Args extends readonly unknown[], Result>(definition: ImplDefinition<Args, Result>): string {
  return [
    `Implement ${definition.name}.`,
    `Parameters: (${definition.parameters.join(", ")})`,
    definition.returnType ? `Return type: ${definition.returnType}` : "",
    `Behavior: ${definition.description}`,
    "Use only standard JavaScript and return the function result."
  ].filter(Boolean).join("\n");
}
