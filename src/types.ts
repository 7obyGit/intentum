export type Awaitable<T> = T | PromiseLike<T>;

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

export interface JsonSchema {
  readonly type?: string;
  readonly title?: string;
  readonly description?: string;
  readonly properties?: Record<string, JsonSchema>;
  readonly required?: readonly string[];
  readonly items?: JsonSchema;
  readonly enum?: readonly JsonPrimitive[];
  readonly additionalProperties?: boolean | JsonSchema;
  readonly [key: string]: unknown;
}

export interface ImageInput {
  readonly data: string;
  readonly mimeType?: string;
  readonly detail?: "low" | "high" | "auto";
}

export interface OutputSchema<T> {
  readonly name: string;
  readonly jsonSchema: JsonSchema;
  parse(value: unknown): T;
  parseJson(value: string): T;
}

export function defineSchema<T>(
  name: string,
  jsonSchema: JsonSchema,
  parse: (value: unknown) => T
): OutputSchema<T> {
  return {
    name,
    jsonSchema,
    parse,
    parseJson(value: string): T {
      return parse(JSON.parse(value) as unknown);
    }
  };
}

export interface GenerateRequest<T> {
  readonly prompt: string;
  readonly system?: string;
  readonly schema?: OutputSchema<T>;
  readonly images?: readonly ImageInput[];
  readonly signal?: AbortSignal;
}

export interface ModelProvider {
  generateText(request: GenerateRequest<never>): Promise<string>;
  generateStructured<T>(request: GenerateRequest<T>): Promise<T>;
}

export interface Cache {
  get(key: string): Promise<string | undefined>;
  set(key: string, value: string): Promise<void>;
}

export interface CacheOptions {
  readonly directory?: string;
}
