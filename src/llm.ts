import { describeArguments, type ContextOptions } from "./context.js";
import { providerFromEnvironment, type ProviderOptions } from "./provider.js";
import type { Awaitable, GenerateRequest, ImageInput, ModelProvider, OutputSchema } from "./types.js";

export interface LlmCallContext<Args extends readonly unknown[]> {
  readonly args: Args;
  readonly displayArgs: readonly unknown[];
  readonly images: readonly ImageInput[];
  readonly files: readonly string[];
}

export interface LlmDefinition<Args extends readonly unknown[], Result> {
  readonly name?: string;
  readonly prompt?: (context: LlmCallContext<Args>) => Awaitable<string>;
  readonly system?: string;
  readonly schema?: OutputSchema<Result>;
  readonly provider?: ModelProvider;
  readonly providerOptions?: ProviderOptions;
  readonly context?: ContextOptions;
  readonly images?: (context: LlmCallContext<Args>) => Awaitable<readonly ImageInput[]>;
}

/** Define a typed function backed by text or structured model output. */
export function llm<Args extends readonly unknown[], Result>(
  definition: LlmDefinition<Args, Result>
): (...args: Args) => Promise<Result> {
  const provider = definition.provider ?? providerFromEnvironment();
  return async (...args: Args): Promise<Result> => {
    const context = await describeArguments(args, definition.context);
    const callContext: LlmCallContext<Args> = {
      args,
      displayArgs: context.display,
      images: context.images,
      files: context.files
    };
    const prompt = await (definition.prompt?.(callContext) ?? JSON.stringify(context.display));
    const images = [
      ...context.images,
      ...(definition.images ? await definition.images(callContext) : [])
    ];
    const request: GenerateRequest<Result> = {
      prompt,
      ...(definition.system ? { system: definition.system } : {}),
      ...(definition.schema ? { schema: definition.schema } : {}),
      ...(images.length ? { images } : {})
    };
    if (definition.schema) return provider.generateStructured(request);
    return provider.generateText(request as GenerateRequest<never>) as Promise<Result>;
  };
}
