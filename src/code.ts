import { createHash } from "node:crypto";

export function normalizeGeneratedCode(source: string): string {
  const fenced = source.match(/```(?:typescript|javascript|ts|js)?\s*([\s\S]*?)```/i);
  const code = (fenced?.[1] ?? source).trim();
  return code.replace(/^\s*return\s+```[\s\S]*?```\s*$/i, "").trim();
}

export function compileBody<Args extends readonly unknown[], Result>(
  parameters: readonly string[],
  body: string
): (...args: Args) => Promise<Result> {
  const source = [
    "\"use strict\";",
    "return (async () => {",
    body,
    "})();"
  ].join("\n");
  const factory = new Function(...parameters, source) as (...args: Args) => Promise<Result>;
  return (...args: Args) => factory(...args);
}

export function hashDefinition(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
