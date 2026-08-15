export type Awaitable<T> = T | PromiseLike<T>;

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
export type JsonSchemaType = "null" | "boolean" | "object" | "array" | "number" | "integer" | "string";

export interface JsonSchema {
  readonly $id?: string;
  readonly $ref?: string;
  readonly $defs?: Record<string, JsonSchema>;
  readonly type?: JsonSchemaType | readonly JsonSchemaType[] | string;
  readonly title?: string;
  readonly description?: string;
  readonly properties?: Record<string, JsonSchema>;
  readonly required?: readonly string[];
  readonly items?: JsonSchema | readonly JsonSchema[] | false;
  readonly additionalItems?: boolean | JsonSchema;
  readonly prefixItems?: readonly JsonSchema[];
  readonly enum?: readonly JsonValue[];
  readonly const?: JsonValue;
  readonly anyOf?: readonly JsonSchema[];
  readonly oneOf?: readonly JsonSchema[];
  readonly allOf?: readonly JsonSchema[];
  readonly not?: JsonSchema;
  readonly contains?: JsonSchema;
  readonly additionalProperties?: boolean | JsonSchema;
  readonly patternProperties?: Record<string, JsonSchema>;
  readonly propertyNames?: JsonSchema;
  readonly minProperties?: number;
  readonly maxProperties?: number;
  readonly minItems?: number;
  readonly maxItems?: number;
  readonly uniqueItems?: boolean;
  readonly minLength?: number;
  readonly maxLength?: number;
  readonly pattern?: string;
  readonly format?: string;
  readonly minimum?: number;
  readonly maximum?: number;
  readonly exclusiveMinimum?: number | boolean;
  readonly exclusiveMaximum?: number | boolean;
  readonly multipleOf?: number;
  readonly [key: string]: unknown;
}

export interface ValidationIssue {
  readonly path: string;
  readonly keyword: string;
  readonly message: string;
  readonly expected?: unknown;
  readonly received?: unknown;
  readonly params?: Readonly<Record<string, unknown>>;
}

/** A stable, path-aware error for values that do not satisfy an OutputSchema. */
export class SchemaValidationError extends TypeError {
  readonly schemaName: string;
  readonly issues: readonly ValidationIssue[];

  constructor(schemaName: string, issues: readonly ValidationIssue[], cause?: unknown) {
    const summary = issues.length > 0
      ? issues.map((issue) => `${issue.path}: ${issue.message}`).join("; ")
      : "value is invalid";
    super(`Schema "${schemaName}" validation failed: ${summary}`, { cause });
    this.name = "SchemaValidationError";
    this.schemaName = schemaName;
    this.issues = issues;
  }
}

/** Wraps a provider response that could not be parsed as the requested structured output. */
export class StructuredOutputError extends Error {
  readonly schemaName: string;
  readonly rawOutput: string;

  constructor(schemaName: string, rawOutput: string, cause: unknown) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    super(`Structured output for schema "${schemaName}" was invalid: ${detail}`, { cause });
    this.name = "StructuredOutputError";
    this.schemaName = schemaName;
    this.rawOutput = rawOutput;
  }
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
  const parseValue = (value: unknown): T => {
    try {
      return parse(value);
    } catch (error) {
      throw normalizeSchemaError(name, error);
    }
  };
  return {
    name,
    jsonSchema,
    parse: parseValue,
    parseJson(value: string): T {
      let parsed: unknown;
      try {
        parsed = JSON.parse(value) as unknown;
      } catch (error) {
        throw new SchemaValidationError(name, [{
          path: "$",
          keyword: "json",
          message: error instanceof Error ? error.message : "Invalid JSON"
        }], error);
      }
      return parseValue(parsed);
    }
  };
}

function normalizeSchemaError(name: string, error: unknown): SchemaValidationError {
  if (error instanceof SchemaValidationError) return error;
  const candidate = error as { issues?: unknown } | undefined;
  if (candidate && Array.isArray(candidate.issues)) {
    const issues = candidate.issues.flatMap((issue): ValidationIssue[] => {
      if (typeof issue !== "object" || issue === null) return [];
      const value = issue as { path?: unknown; code?: unknown; message?: unknown; expected?: unknown; received?: unknown };
      const path = Array.isArray(value.path)
        ? formatPath(value.path)
        : typeof value.path === "string" ? value.path : "$";
      return [{
        path,
        keyword: typeof value.code === "string" ? value.code : "custom",
        message: typeof value.message === "string" ? value.message : "value is invalid",
        ...(value.expected === undefined ? {} : { expected: value.expected }),
        ...(value.received === undefined ? {} : { received: value.received })
      }];
    });
    if (issues.length > 0) return new SchemaValidationError(name, issues, error);
  }
  return new SchemaValidationError(name, [{
    path: "$",
    keyword: "custom",
    message: error instanceof Error ? error.message : String(error)
  }], error);
}

function formatPath(path: readonly unknown[]): string {
  return path.reduce<string>((result, segment) => {
    if (typeof segment === "number") return `${result}[${segment}]`;
    if (typeof segment !== "string") return result;
    return /^[A-Za-z_$][\w$]*$/.test(segment) ? `${result}.${segment}` : `${result}[${JSON.stringify(segment)}]`;
  }, "$" as string);
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
