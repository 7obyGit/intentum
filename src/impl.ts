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
  readonly intelligence?: ProviderOptions["intelligence"];
  /** Explicitly invalidate generated code when external dependencies change. */
  readonly cacheVersion?: string;
  readonly cacheKey?: string;
  readonly cache?: Cache | false;
}

/** Generate a JavaScript function body from a declarative specification and cache it. */
export function impl<Args extends readonly unknown[], Result>(
  definition: ImplDefinition<Args, Result>
): (...args: Args) => Promise<Result> {
  const provider = definition.provider ?? providerFromEnvironment({
    ...definition.providerOptions,
    ...(definition.intelligence === undefined ? {} : { intelligence: definition.intelligence })
  });
  const cache = definition.cache === false ? undefined : (definition.cache ?? new FileCache());
  const key = hashDefinition({
    version: 2,
    name: definition.name,
    parameters: definition.parameters,
    description: definition.description,
    returnType: definition.returnType,
    prompt: definition.prompt?.toString(),
    cacheVersion: definition.cacheVersion,
    cacheKey: definition.cacheKey,
    intelligence: definition.intelligence,
    provider: cacheProviderIdentity(definition.providerOptions)
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

function cacheProviderIdentity(options: ProviderOptions | undefined): unknown {
  if (!options) return undefined;
  return {
    provider: options.provider,
    intelligence: options.intelligence,
    openai: options.openai && {
      baseURL: options.openai.baseURL,
      model: options.openai.model,
      intelligence: options.openai.intelligence
    },
    local: options.local && {
      baseURL: options.local.baseURL,
      model: options.local.model,
      intelligence: options.local.intelligence
    },
    codex: options.codex && {
      command: options.codex.command,
      model: options.codex.model,
      intelligence: options.codex.intelligence
    },
    auto: options.auto && {
      localBaseURLs: options.auto.localBaseURLs,
      codex: options.auto.codex && {
        command: options.auto.codex.command,
        model: options.auto.codex.model,
        intelligence: options.auto.codex.intelligence
      },
      local: options.auto.local && {
        baseURL: options.auto.local.baseURL,
        model: options.auto.local.model,
        intelligence: options.auto.local.intelligence
      },
      openai: options.auto.openai && {
        baseURL: options.auto.openai.baseURL,
        model: options.auto.openai.model,
        intelligence: options.auto.openai.intelligence
      }
    }
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
