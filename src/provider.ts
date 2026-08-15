import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { spawn, spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { modelForIntelligence, parseIntelligence, type Intelligence } from "./model.js";
import {
  StructuredOutputError,
  type GenerateRequest,
  type ImageInput,
  type JsonValue,
  type ModelProvider,
  type OutputSchema
} from "./types.js";

export interface ProviderRetryOptions {
  /** Maximum retries after the initial request. Defaults to two. */
  readonly maxRetries?: number;
  readonly retryDelayMs?: number;
  readonly retryBackoff?: number;
  /** Fractional random jitter added to retry delays. Defaults to 0.2. */
  readonly retryJitter?: number;
  /** Request/process timeout. Defaults to 30 seconds. Set to zero to disable. */
  readonly timeoutMs?: number;
}

export type ProviderErrorCode =
  | "AUTH"
  | "NETWORK"
  | "TIMEOUT"
  | "RATE_LIMIT"
  | "HTTP"
  | "INVALID_RESPONSE"
  | "UNAVAILABLE"
  | "COMMAND_FAILED";

export interface ProviderErrorOptions {
  readonly provider: string;
  readonly code: ProviderErrorCode;
  readonly retryable: boolean;
  readonly status?: number;
  readonly requestId?: string;
  readonly retryAfterMs?: number;
  readonly cause?: unknown;
}

export class ProviderError extends Error {
  readonly provider: string;
  readonly code: ProviderErrorCode;
  readonly retryable: boolean;
  readonly status?: number;
  readonly requestId?: string;
  readonly retryAfterMs?: number;

  constructor(message: string, options: ProviderErrorOptions) {
    super(message, { cause: options.cause });
    this.name = "ProviderError";
    this.provider = options.provider;
    this.code = options.code;
    this.retryable = options.retryable;
    if (options.status !== undefined) this.status = options.status;
    if (options.requestId !== undefined) this.requestId = options.requestId;
    if (options.retryAfterMs !== undefined) this.retryAfterMs = options.retryAfterMs;
  }
}

export interface OpenAICompatibleOptions extends ProviderRetryOptions {
  readonly apiKey?: string;
  readonly baseURL?: string;
  readonly model?: string;
  readonly intelligence?: Intelligence;
  /** Local OpenAI-compatible servers such as Ollama often do not require a key. */
  readonly allowAnonymous?: boolean;
  readonly fetch?: typeof globalThis.fetch;
  readonly onResponse?: (metadata: ProviderResponseMetadata) => void;
}

export interface ProviderUsage {
  readonly promptTokens?: number;
  readonly completionTokens?: number;
  readonly totalTokens?: number;
}

export interface ProviderResponseMetadata {
  readonly provider: string;
  readonly model: string;
  readonly status: number;
  readonly latencyMs: number;
  readonly requestId?: string;
  readonly finishReason?: string;
  readonly usage?: ProviderUsage;
}

type MessageContent = string | readonly {
  readonly type: string;
  readonly text?: string;
  readonly image_url?: { readonly url: string; readonly detail?: string };
}[];

export class OpenAICompatibleProvider implements ModelProvider {
  private readonly apiKey: string;
  private readonly baseURL: string;
  private readonly model: string;
  private readonly fetchImpl: typeof globalThis.fetch;
  private readonly options: OpenAICompatibleOptions;
  private readonly allowAnonymous: boolean;

  constructor(options: OpenAICompatibleOptions = {}) {
    const intelligence = options.intelligence ?? parseIntelligence(process.env.INTENTUM_INTELLIGENCE);
    this.apiKey = options.apiKey ?? process.env.INTENTUM_API_KEY ?? process.env.OPENAI_API_KEY ?? "";
    this.baseURL = (options.baseURL ?? process.env.INTENTUM_BASE_URL ?? "https://api.openai.com/v1").replace(/\/$/, "");
    this.model = options.model
      ?? (intelligence ? modelForIntelligence(intelligence) : undefined)
      ?? process.env.INTENTUM_MODEL
      ?? "gpt-4o-mini";
    this.fetchImpl = options.fetch ?? globalThis.fetch;
    this.options = options;
    this.allowAnonymous = options.allowAnonymous ?? false;
  }

  async generateText(request: GenerateRequest<never>): Promise<string> {
    const response = await this.complete(request);
    return extractContent(response, "openai");
  }

  async generateStructured<T>(request: GenerateRequest<T>): Promise<T> {
    if (!request.schema) throw new Error("A schema is required for structured generation");
    const response = await this.complete(request);
    return parseStructuredOutput(request.schema, extractContent(response, "openai"));
  }

  private async complete<T>(request: GenerateRequest<T>): Promise<unknown> {
    if (!this.apiKey && !this.allowAnonymous) {
      throw new ProviderError("No API key configured; set INTENTUM_API_KEY or OPENAI_API_KEY", {
        provider: "openai",
        code: "AUTH",
        retryable: false
      });
    }
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
    const startedAt = Date.now();
    return withProviderRetries("openai", this.options, request.signal, async () => {
      let response: Response;
      try {
        response = await fetchWithTimeout(this.fetchImpl, `${this.baseURL}/chat/completions`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            ...(this.apiKey ? { authorization: `Bearer ${this.apiKey}` } : {})
          },
          body: JSON.stringify(body),
          ...(request.signal ? { signal: request.signal } : {})
        }, this.options.timeoutMs);
      } catch (error) {
        if (error instanceof ProviderError) throw error;
        throw new ProviderError(`OpenAI-compatible request failed: ${error instanceof Error ? error.message : String(error)}`, {
          provider: "openai",
          code: "NETWORK",
          retryable: true,
          cause: error
        });
      }
      const payload = await readResponsePayload(response);
      if (!response.ok) {
        const status = response.status;
        const errorPayload = payload as { error?: { message?: unknown; code?: unknown } };
        const message = typeof errorPayload.error?.message === "string"
          ? errorPayload.error.message
          : `HTTP ${status}`;
        const code = status === 401 || status === 403
          ? "AUTH"
          : status === 429
            ? "RATE_LIMIT"
            : "HTTP";
        throw new ProviderError(`Model request failed (${status}): ${message}`, {
          provider: "openai",
          code,
          retryable: status === 408 || status === 409 || status === 425 || status === 429 || status >= 500,
          status,
          ...(response.headers.get("x-request-id") ? { requestId: response.headers.get("x-request-id") as string } : {}),
          ...(parseRetryAfter(response.headers.get("retry-after")) === undefined
            ? {}
            : { retryAfterMs: parseRetryAfter(response.headers.get("retry-after")) as number })
        });
      }
      const requestId = response.headers.get("x-request-id");
      const choice = (payload as { choices?: { finish_reason?: unknown }[] }).choices?.[0];
      const usage = toProviderUsage((payload as { usage?: unknown }).usage);
      notifyResponse(this.options.onResponse, {
        provider: "openai",
        model: this.model,
        status: response.status,
        latencyMs: Date.now() - startedAt,
        ...(requestId ? { requestId } : {}),
        ...(typeof choice?.finish_reason === "string" ? { finishReason: choice.finish_reason } : {}),
        ...(usage ? { usage } : {})
      });
      return payload;
    });
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

function extractContent(response: unknown, provider: string): string {
  const message = (response as { choices?: { message?: { content?: unknown; refusal?: unknown } }[] }).choices?.[0]?.message;
  if (typeof message?.refusal === "string") {
    throw new ProviderError(`Model refused the request: ${message.refusal}`, {
      provider,
      code: "INVALID_RESPONSE",
      retryable: false
    });
  }
  const content = message?.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const text = content.flatMap((part) => {
      if (typeof part !== "object" || part === null) return [];
      const value = (part as { text?: unknown }).text;
      return typeof value === "string" ? [value] : [];
    }).join("");
    if (text) return text;
  }
  {
    throw new ProviderError("Model response did not contain message content", {
      provider,
      code: "INVALID_RESPONSE",
      retryable: false
    });
  }
}

function toProviderUsage(value: unknown): ProviderUsage | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const usage = value as { prompt_tokens?: unknown; completion_tokens?: unknown; total_tokens?: unknown };
  const promptTokens = typeof usage.prompt_tokens === "number" ? usage.prompt_tokens : undefined;
  const completionTokens = typeof usage.completion_tokens === "number" ? usage.completion_tokens : undefined;
  const totalTokens = typeof usage.total_tokens === "number" ? usage.total_tokens : undefined;
  if (promptTokens === undefined && completionTokens === undefined && totalTokens === undefined) return undefined;
  return {
    ...(promptTokens === undefined ? {} : { promptTokens }),
    ...(completionTokens === undefined ? {} : { completionTokens }),
    ...(totalTokens === undefined ? {} : { totalTokens })
  };
}

function notifyResponse(
  callback: ((metadata: ProviderResponseMetadata) => void) | undefined,
  metadata: ProviderResponseMetadata
): void {
  try {
    callback?.(metadata);
  } catch {
    // Telemetry hooks must not turn a successful model response into a failed request.
  }
}

export interface CodexOptions extends ProviderRetryOptions {
  readonly command?: string;
  readonly model?: string;
  readonly intelligence?: Intelligence;
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
  private readonly options: ProviderRetryOptions;

  constructor(options: CodexOptions = {}) {
    const intelligence = options.intelligence ?? parseIntelligence(process.env.INTENTUM_INTELLIGENCE);
    this.command = options.command ?? process.env.INTENTUM_CODEX_COMMAND ?? "codex";
    this.model = options.model
      ?? (intelligence ? modelForIntelligence(intelligence) : undefined)
      ?? process.env.INTENTUM_CODEX_MODEL;
    this.cwd = options.cwd;
    this.sandbox = options.sandbox ?? "workspace-write";
    this.options = options;
  }

  async generateText(request: GenerateRequest<never>): Promise<string> {
    const result = await this.execute(request.prompt, request.images, undefined, undefined, request.signal);
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
      return parseStructuredOutput(request.schema, content);
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
    try {
      const captured = await withProviderRetries("codex", this.options, signal, async () => {
        const managed = createManagedSignal(signal, this.options.timeoutMs);
        try {
          const result = await spawnCapture(this.command, args, this.cwd, managed.signal);
          if (result.code !== 0) {
            throw new ProviderError(`Codex exited with status ${result.code}: ${result.stderr.trim() || result.stdout.trim() || "unknown error"}`, {
              provider: "codex",
              code: "COMMAND_FAILED",
              retryable: true
            });
          }
          return result;
        } catch (error) {
          if (managed.timedOut) {
            throw new ProviderError(`Codex timed out after ${this.options.timeoutMs ?? 30_000}ms`, {
              provider: "codex",
              code: "TIMEOUT",
              retryable: true,
              cause: error
            });
          }
          if (error instanceof ProviderError) throw error;
          const unavailable = (error as NodeJS.ErrnoException).code === "ENOENT";
          throw new ProviderError(`Unable to execute Codex: ${error instanceof Error ? error.message : String(error)}`, {
            provider: "codex",
            code: unavailable ? "UNAVAILABLE" : "NETWORK",
            retryable: !unavailable,
            cause: error
          });
        } finally {
          managed.cleanup();
        }
      });
      const events = parseEvents(captured.stdout);
      const threadId = events.find((event) => event.type === "thread.started")?.thread_id;
      const message = [...events].reverse().find((event) => event.type === "item.completed" && (event.item as { type?: string } | undefined)?.type === "agent_message");
      const output = typeof (message?.item as { text?: unknown } | undefined)?.text === "string"
        ? (message?.item as { text: string }).text
        : captured.stdout.trim();
      return { output, events, returncode: captured.code, ...(typeof threadId === "string" ? { threadId } : {}) };
    } finally {
      await Promise.all(imageDirectories.map((directory) => rm(directory, { recursive: true, force: true })));
    }
  }
}

export interface AutoProviderOptions extends ProviderRetryOptions {
  readonly codex?: CodexOptions;
  readonly local?: OpenAICompatibleOptions;
  readonly openai?: OpenAICompatibleOptions;
  readonly localBaseURLs?: readonly string[];
  readonly probeTimeoutMs?: number;
}

/** Select Codex first, then a reachable local OpenAI-compatible server, then cloud OpenAI. */
export class AutoProvider implements ModelProvider {
  private readonly options: AutoProviderOptions;
  private candidatesPromise?: Promise<readonly ModelProvider[]>;
  private active?: ModelProvider;

  constructor(options: AutoProviderOptions = {}) {
    this.options = options;
  }

  async generateText(request: GenerateRequest<never>): Promise<string> {
    return this.run((provider) => provider.generateText(request));
  }

  async generateStructured<T>(request: GenerateRequest<T>): Promise<T> {
    return this.run((provider) => provider.generateStructured(request));
  }

  private async run<T>(operation: (provider: ModelProvider) => Promise<T>): Promise<T> {
    const candidates = this.active ? [this.active] : await (this.candidatesPromise ??= this.discover());
    let lastError: unknown;
    for (const candidate of candidates) {
      try {
        const result = await operation(candidate);
        this.active = candidate;
        return result;
      } catch (error) {
        lastError = error;
        if (!isFallbackEligible(error)) throw error;
      }
    }
    throw lastError ?? new ProviderError("No usable model provider was detected", {
      provider: "auto",
      code: "UNAVAILABLE",
      retryable: false
    });
  }

  private async discover(): Promise<readonly ModelProvider[]> {
    const providers: ModelProvider[] = [];
    const codexOptions = this.options.codex ?? {};
    const codexCommand = codexOptions.command ?? process.env.INTENTUM_CODEX_COMMAND ?? "codex";
    if (commandAvailable(codexCommand)) providers.push(new CodexProvider({ ...this.options, ...codexOptions }));

    const localOptions = this.options.local ?? {};
    const configuredBaseURL = process.env.INTENTUM_LOCAL_BASE_URL
      ?? (isLocalBaseURL(process.env.INTENTUM_BASE_URL) ? process.env.INTENTUM_BASE_URL : undefined);
    const localBaseURLs = this.options.localBaseURLs
      ?? (configuredBaseURL ? [configuredBaseURL] : [
        "http://127.0.0.1:11434/v1",
        "http://127.0.0.1:1234/v1"
      ]);
    for (const baseURL of localBaseURLs) {
      if (await endpointAvailable(baseURL, localOptions.fetch ?? globalThis.fetch, this.options.probeTimeoutMs ?? 250)) {
        providers.push(new OpenAICompatibleProvider({
          ...this.options,
          ...localOptions,
          baseURL,
          model: localOptions.model ?? process.env.INTENTUM_LOCAL_MODEL ?? "llama3.2",
          allowAnonymous: true,
          apiKey: localOptions.apiKey ?? "local"
        }));
      }
    }

    const apiKey = process.env.INTENTUM_API_KEY ?? process.env.OPENAI_API_KEY;
    const cloudOptions = this.options.openai ?? {};
    if (apiKey) providers.push(new OpenAICompatibleProvider({ ...this.options, ...cloudOptions, apiKey, allowAnonymous: false }));
    if (providers.length === 0) {
      throw new ProviderError("No provider detected. Install/authenticate Codex, start a local LLM, or set INTENTUM_API_KEY.", {
        provider: "auto",
        code: "UNAVAILABLE",
        retryable: false
      });
    }
    return providers;
  }
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
    return parseStructuredOutput(request.schema, JSON.stringify(value));
  }
}

export interface ProviderOptions extends ProviderRetryOptions {
  readonly provider?: "auto" | "openai" | "codex" | "local";
  readonly intelligence?: Intelligence;
  readonly openai?: OpenAICompatibleOptions;
  readonly local?: OpenAICompatibleOptions;
  readonly codex?: CodexOptions;
  readonly auto?: AutoProviderOptions;
}

export function createProvider(options: ProviderOptions = {}): ModelProvider {
  const selected = options.provider ?? process.env.INTENTUM_PROVIDER ?? "auto";
  const intelligence = options.intelligence ?? parseIntelligence(process.env.INTENTUM_INTELLIGENCE);
  if (selected === "codex") return new CodexProvider(withIntelligence(withRetryOptions(options.codex, options), intelligence));
  if (selected === "local") return new OpenAICompatibleProvider({
    ...withIntelligence(withRetryOptions(options.local, options), intelligence),
    baseURL: options.local?.baseURL ?? process.env.INTENTUM_LOCAL_BASE_URL ?? "http://127.0.0.1:11434/v1",
    model: options.local?.model ?? process.env.INTENTUM_LOCAL_MODEL ?? "llama3.2",
    allowAnonymous: true,
    apiKey: options.local?.apiKey ?? "local"
  });
  if (selected === "openai") return new OpenAICompatibleProvider(withIntelligence(withRetryOptions(options.openai, options), intelligence));
  return new AutoProvider({
    ...options,
    ...options.auto,
    openai: withIntelligence(options.auto?.openai ?? options.openai, intelligence),
    codex: withIntelligence(options.auto?.codex ?? options.codex, intelligence),
    local: withIntelligence(options.auto?.local ?? options.local, intelligence)
  });
}

export function providerFromEnvironment(options: ProviderOptions = {}): ModelProvider {
  return createProvider(options);
}

export function parseStructuredOutput<T>(schema: OutputSchema<T>, content: string): T {
  try {
    return schema.parseJson(content);
  } catch (error) {
    throw new StructuredOutputError(schema.name, content, error);
  }
}

export async function withProviderRetries<T>(
  provider: string,
  options: ProviderRetryOptions,
  signal: AbortSignal | undefined,
  operation: () => Promise<T>
): Promise<T> {
  const maxRetries = Math.max(0, Math.floor(options.maxRetries ?? 2));
  const backoff = Math.max(1, options.retryBackoff ?? 2);
  const jitter = Math.max(0, options.retryJitter ?? 0.2);
  let delay = Math.max(0, options.retryDelayMs ?? 250);
  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    if (signal?.aborted) throw signal.reason ?? new DOMException("The operation was aborted", "AbortError");
    try {
      return await operation();
    } catch (error) {
      if (signal?.aborted || isAbortError(error)) throw signal?.reason ?? error;
      const normalized = error instanceof ProviderError
        ? error
        : new ProviderError(`${provider} request failed: ${error instanceof Error ? error.message : String(error)}`, {
          provider,
          code: "NETWORK",
          retryable: true,
          cause: error
        });
      if (!normalized.retryable || attempt >= maxRetries) throw normalized;
      const retryAfter = normalized.retryAfterMs ?? 0;
      const jitterAmount = delay * jitter * Math.random();
      await sleepWithSignal(Math.max(retryAfter, delay + jitterAmount), signal);
      delay *= backoff;
    }
  }
  throw new Error("Unreachable provider retry state");
}

async function readResponsePayload(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) return {};
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return { raw: text };
  }
}

async function fetchWithTimeout(
  fetchImpl: typeof globalThis.fetch,
  input: string | URL,
  init: RequestInit,
  timeoutMs: number | undefined
): Promise<Response> {
  const managed = createManagedSignal(init.signal ?? undefined, timeoutMs);
  try {
    return await fetchImpl(input, { ...init, signal: managed.signal });
  } catch (error) {
    if (managed.timedOut) {
      throw new ProviderError(`Request timed out after ${timeoutMs ?? 30_000}ms`, {
        provider: "openai",
        code: "TIMEOUT",
        retryable: true,
        cause: error
      });
    }
    throw error;
  } finally {
    managed.cleanup();
  }
}

function createManagedSignal(external: AbortSignal | undefined, timeoutMs: number | undefined): {
  signal: AbortSignal;
  timedOut: boolean;
  cleanup: () => void;
} {
  const controller = new AbortController();
  let timedOut = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const onAbort = (): void => controller.abort(external?.reason);
  if (external) {
    if (external.aborted) controller.abort(external.reason);
    else external.addEventListener("abort", onAbort, { once: true });
  }
  if (timeoutMs !== undefined ? timeoutMs > 0 : true) {
    timer = setTimeout(() => {
      timedOut = true;
      controller.abort(new DOMException("The operation timed out", "TimeoutError"));
    }, timeoutMs ?? 30_000);
  }
  return {
    signal: controller.signal,
    get timedOut() { return timedOut; },
    cleanup: () => {
      if (timer) clearTimeout(timer);
      external?.removeEventListener("abort", onAbort);
    }
  };
}

function parseRetryAfter(value: string | null): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? Math.max(0, timestamp - Date.now()) : undefined;
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError");
}

async function sleepWithSignal(delayMs: number, signal: AbortSignal | undefined): Promise<void> {
  if (delayMs <= 0) return;
  await new Promise<void>((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout>;
    const cleanup = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    };
    const finish = (): void => {
      cleanup();
      resolve();
    };
    const onAbort = (): void => {
      cleanup();
      reject(signal?.reason ?? new DOMException("The operation was aborted", "AbortError"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    timer = setTimeout(finish, delayMs);
  });
}

function materializeImage(image: ImageInput): Promise<{ path: string; directory: string }> {
  return mkdtemp(join(tmpdir(), "intentum-image-")).then(async (directory) => {
    const extension = image.mimeType?.split("/")[1] ?? "png";
    const path = join(directory, `image.${extension}`);
    await writeFile(path, Buffer.from(image.data, "base64"));
    return { path, directory };
  });
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

function commandAvailable(command: string): boolean {
  const result = spawnSync(command, ["--version"], { stdio: "ignore", timeout: 1_000 });
  return result.error === undefined && result.status === 0;
}

async function endpointAvailable(baseURL: string, fetchImpl: typeof globalThis.fetch, timeoutMs: number): Promise<boolean> {
  try {
    const response = await fetchWithTimeout(fetchImpl, `${baseURL.replace(/\/$/, "")}/models`, {
      method: "GET"
    }, timeoutMs);
    return response.ok || response.status === 401 || response.status === 403;
  } catch {
    return false;
  }
}

function isLocalBaseURL(value: string | undefined): value is string {
  if (!value) return false;
  try {
    const url = new URL(value);
    return url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "::1";
  } catch {
    return false;
  }
}

function isFallbackEligible(error: unknown): boolean {
  if (!(error instanceof ProviderError)) return false;
  return error.code === "UNAVAILABLE" || error.code === "AUTH" || error.code === "NETWORK" || error.code === "COMMAND_FAILED";
}

function withIntelligence<T extends { readonly intelligence?: Intelligence }>(options: T | undefined, intelligence: Intelligence | undefined): T & { readonly intelligence?: Intelligence } {
  if (!intelligence || options?.intelligence !== undefined) return (options ?? {}) as T & { readonly intelligence?: Intelligence };
  return { ...(options ?? {}), intelligence } as T & { readonly intelligence?: Intelligence };
}

function withRetryOptions<T extends ProviderRetryOptions>(options: T | undefined, parent: ProviderRetryOptions): T & ProviderRetryOptions {
  return {
    ...(parent.maxRetries === undefined ? {} : { maxRetries: parent.maxRetries }),
    ...(parent.retryDelayMs === undefined ? {} : { retryDelayMs: parent.retryDelayMs }),
    ...(parent.retryBackoff === undefined ? {} : { retryBackoff: parent.retryBackoff }),
    ...(parent.retryJitter === undefined ? {} : { retryJitter: parent.retryJitter }),
    ...(parent.timeoutMs === undefined ? {} : { timeoutMs: parent.timeoutMs }),
    ...(options ?? {})
  } as T & ProviderRetryOptions;
}
