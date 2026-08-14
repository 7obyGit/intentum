import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import type { GenerateRequest, ImageInput, JsonValue, ModelProvider, OutputSchema } from "./types.js";

export interface OpenAICompatibleOptions {
  readonly apiKey?: string;
  readonly baseURL?: string;
  readonly model?: string;
  readonly fetch?: typeof globalThis.fetch;
}

type MessageContent = string | readonly { readonly type: string; readonly text?: string; readonly image_url?: { readonly url: string; readonly detail?: string } }[];

export class OpenAICompatibleProvider implements ModelProvider {
  private readonly apiKey: string;
  private readonly baseURL: string;
  private readonly model: string;
  private readonly fetchImpl: typeof globalThis.fetch;

  constructor(options: OpenAICompatibleOptions = {}) {
    this.apiKey = options.apiKey ?? process.env.INTENTUM_API_KEY ?? process.env.OPENAI_API_KEY ?? "";
    this.baseURL = (options.baseURL ?? process.env.INTENTUM_BASE_URL ?? "https://api.openai.com/v1").replace(/\/$/, "");
    this.model = options.model ?? process.env.INTENTUM_MODEL ?? "gpt-4o-mini";
    this.fetchImpl = options.fetch ?? globalThis.fetch;
  }

  async generateText(request: GenerateRequest<never>): Promise<string> {
    const response = await this.complete(request);
    return extractContent(response);
  }

  async generateStructured<T>(request: GenerateRequest<T>): Promise<T> {
    if (!request.schema) throw new Error("A schema is required for structured generation");
    const response = await this.complete(request);
    return request.schema.parseJson(extractContent(response));
  }

  private async complete<T>(request: GenerateRequest<T>): Promise<unknown> {
    if (!this.apiKey) throw new Error("No API key configured; set INTENTUM_API_KEY or OPENAI_API_KEY");
    const messages = [
      ...(request.system ? [{ role: "system", content: request.system }] : []),
      { role: "user", content: toMessageContent(request.prompt, request.images) }
    ];
    const body: Record<string, JsonValue | unknown> = {
      model: this.model,
      messages
    };
    if (request.schema) {
      body.response_format = {
        type: "json_schema",
        json_schema: {
          name: request.schema.name,
          strict: true,
          schema: request.schema.jsonSchema
        }
      };
    }
    const response = await this.fetchImpl(`${this.baseURL}/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${this.apiKey}`
      },
      body: JSON.stringify(body),
      ...(request.signal ? { signal: request.signal } : {})
    });
    const payload = await response.json() as { error?: { message?: string } };
    if (!response.ok) throw new Error(`Model request failed (${response.status}): ${payload.error?.message ?? "unknown error"}`);
    return payload;
  }
}

function toMessageContent(prompt: string, images: readonly ImageInput[] | undefined): MessageContent {
  if (!images?.length) return prompt;
  return [
    { type: "text", text: prompt },
    ...images.map((image) => ({
      type: "image_url",
      image_url: { url: `data:${image.mimeType ?? "image/png"};base64,${image.data}`, detail: image.detail ?? "auto" }
    }))
  ];
}

function extractContent(response: unknown): string {
  const content = (response as { choices?: { message?: { content?: unknown } }[] }).choices?.[0]?.message?.content;
  if (typeof content !== "string") throw new Error("Model response did not contain message content");
  return content;
}

export interface CodexOptions {
  readonly command?: string;
  readonly model?: string;
  readonly cwd?: string;
  readonly sandbox?: "read-only" | "workspace-write" | "danger-full-access";
}

export interface CodexEvent {
  readonly type: string;
  readonly [key: string]: unknown;
}

export interface CodexTaskResult {
  readonly output: string;
  readonly events: readonly CodexEvent[];
  readonly returncode: number;
  readonly threadId?: string;
}

export class CodexProvider implements ModelProvider {
  private readonly command: string;
  private readonly model: string | undefined;
  private readonly cwd: string | undefined;
  private readonly sandbox: CodexOptions["sandbox"];

  constructor(options: CodexOptions = {}) {
    this.command = options.command ?? process.env.INTENTUM_CODEX_COMMAND ?? "codex";
    this.model = options.model ?? process.env.INTENTUM_CODEX_MODEL;
    this.cwd = options.cwd;
    this.sandbox = options.sandbox ?? "workspace-write";
  }

  async generateText(request: GenerateRequest<never>): Promise<string> {
    const result = await this.execute(request.prompt, request.images);
    return result.output;
  }

  async generateStructured<T>(request: GenerateRequest<T>): Promise<T> {
    if (!request.schema) throw new Error("A schema is required for structured generation");
    const directory = await mkdtemp(join(tmpdir(), "intentum-codex-"));
    const schemaPath = join(directory, "schema.json");
    const outputPath = join(directory, "output.json");
    try {
      await writeFile(schemaPath, JSON.stringify(request.schema.jsonSchema), "utf8");
      const result = await this.execute(request.prompt, request.images, schemaPath, outputPath, request.signal);
      const content = await readFile(outputPath, "utf8").catch(() => result.output);
      return request.schema.parseJson(content);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }

  async runTask(instruction: string, signal?: AbortSignal, images?: readonly ImageInput[]): Promise<CodexTaskResult> {
    return this.execute(instruction, images, undefined, undefined, signal);
  }

  private async execute(
    prompt: string,
    images?: readonly ImageInput[],
    schemaPath?: string,
    outputPath?: string,
    signal?: AbortSignal
  ): Promise<CodexTaskResult> {
    const args = ["exec", "--json", "--ephemeral", "--sandbox", this.sandbox ?? "workspace-write"];
    if (this.cwd) args.push("-C", this.cwd);
    if (this.model) args.push("--model", this.model);
    if (schemaPath) args.push("--output-schema", schemaPath);
    if (outputPath) args.push("--output-last-message", outputPath);
    const imageDirectories: string[] = [];
    for (const image of images ?? []) {
      const materialized = await materializeImage(image);
      imageDirectories.push(materialized.directory);
      args.push("--image", materialized.path);
    }
    args.push(prompt);
    let stdout: string;
    let stderr: string;
    let code: number;
    try {
      ({ stdout, stderr, code } = await spawnCapture(this.command, args, this.cwd, signal));
    } finally {
      await Promise.all(imageDirectories.map((directory) => rm(directory, { recursive: true, force: true })));
    }
    const events = parseEvents(stdout);
    const threadId = events.find((event) => event.type === "thread.started")?.thread_id;
    const message = [...events].reverse().find((event) => event.type === "item.completed" && (event.item as { type?: string } | undefined)?.type === "agent_message");
    const output = typeof (message?.item as { text?: unknown } | undefined)?.text === "string"
      ? (message?.item as { text: string }).text
      : stdout.trim();
    if (code !== 0) throw new Error(`Codex exited with status ${code}: ${stderr.trim() || output || "unknown error"}`);
    return { output, events, returncode: code, ...(typeof threadId === "string" ? { threadId } : {}) };
  }
}

async function materializeImage(image: ImageInput): Promise<{ path: string; directory: string }> {
  const directory = await mkdtemp(join(tmpdir(), "intentum-image-"));
  const extension = image.mimeType?.split("/")[1] ?? "png";
  const path = join(directory, `image.${extension}`);
  await writeFile(path, Buffer.from(image.data, "base64"));
  return { path, directory };
}

function parseEvents(stdout: string): CodexEvent[] {
  return stdout.split(/\r?\n/).flatMap((line) => {
    try {
      const value = JSON.parse(line) as unknown;
      return typeof value === "object" && value !== null && "type" in value
        ? [value as CodexEvent]
        : [];
    } catch {
      return [];
    }
  });
}

function spawnCapture(command: string, args: readonly string[], cwd?: string, signal?: AbortSignal): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, signal, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
    child.on("error", reject);
    child.on("close", (code) => resolve({ stdout, stderr, code: code ?? 1 }));
  });
}

export interface MockProviderResponses {
  readonly text?: string | ((request: GenerateRequest<never>) => string | Promise<string>);
  readonly structured?: unknown | ((request: GenerateRequest<unknown>) => unknown | Promise<unknown>);
}

/** Deterministic provider useful for tests, examples, and local development. */
export class MockProvider implements ModelProvider {
  constructor(private readonly responses: MockProviderResponses = {}) {}

  async generateText(request: GenerateRequest<never>): Promise<string> {
    const response = this.responses.text;
    if (typeof response === "function") return response(request);
    return response ?? "";
  }

  async generateStructured<T>(request: GenerateRequest<T>): Promise<T> {
    const response = this.responses.structured;
    const value = typeof response === "function" ? await response(request as GenerateRequest<unknown>) : response;
    if (!request.schema) throw new Error("A schema is required for structured generation");
    return request.schema.parse(value);
  }
}

export interface ProviderOptions {
  readonly provider?: "auto" | "openai" | "codex";
  readonly openai?: OpenAICompatibleOptions;
  readonly codex?: CodexOptions;
}

export function createProvider(options: ProviderOptions = {}): ModelProvider {
  const selected = options.provider ?? process.env.INTENTUM_PROVIDER ?? "auto";
  if (selected === "codex") return new CodexProvider(options.codex);
  return new OpenAICompatibleProvider(options.openai);
}

export function providerFromEnvironment(): ModelProvider {
  return createProvider();
}
