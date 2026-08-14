import { describeArguments } from "./context.js";
import { CodexProvider, type CodexOptions, type CodexTaskResult } from "./provider.js";
import type { Awaitable, ImageInput } from "./types.js";

export interface TaskDefinition<Args extends readonly unknown[]> {
  readonly name?: string;
  readonly instruction: (args: Args, displayArgs: readonly unknown[]) => Awaitable<string>;
  readonly codex?: CodexProvider;
  readonly codexOptions?: CodexOptions;
  readonly images?: (args: Args) => Awaitable<readonly ImageInput[]>;
}

export async function runTask(instruction: string, options: CodexOptions = {}): Promise<CodexTaskResult> {
  return new CodexProvider(options).runTask(instruction);
}

/** Define a reusable, non-interactive Codex task. */
export function task<Args extends readonly unknown[]>(
  definition: TaskDefinition<Args>
): (...args: Args) => Promise<CodexTaskResult> {
  const codex = definition.codex ?? new CodexProvider(definition.codexOptions);
  return async (...args: Args): Promise<CodexTaskResult> => {
    const context = await describeArguments(args);
    const instruction = await definition.instruction(args, context.display);
    const images = [
      ...context.images,
      ...(definition.images ? await definition.images(args) : [])
    ];
    return codex.runTask(instruction, undefined, images);
  };
}
