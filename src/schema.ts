import { Ajv, type ErrorObject, type ValidateFunction } from "ajv";
import * as addFormatsModule from "ajv-formats";
import {
  defineSchema,
  SchemaValidationError,
  type JsonSchema,
  type JsonValue,
  type OutputSchema,
  type ValidationIssue
} from "./types.js";

export {
  defineSchema,
  SchemaValidationError,
  StructuredOutputError
} from "./types.js";
export type { JsonSchema, JsonValue, OutputSchema, ValidationIssue } from "./types.js";

const jsonValidator = new Ajv({
  allErrors: true,
  allowUnionTypes: true,
  coerceTypes: false,
  removeAdditional: true,
  strict: false,
  useDefaults: false
});
const addFormats = (addFormatsModule as unknown as {
  default: (ajv: Ajv) => void;
}).default;
addFormats(jsonValidator);

export interface ZodLike<T> {
  parse(value: unknown): T;
  toJSONSchema?: () => JsonSchema;
  _def?: unknown;
}

export interface StringSchemaOptions {
  readonly minLength?: number;
  readonly maxLength?: number;
  readonly pattern?: string;
  readonly format?: string;
}

export interface NumberSchemaOptions {
  readonly integer?: boolean;
  readonly minimum?: number;
  readonly maximum?: number;
  readonly exclusiveMinimum?: number;
  readonly exclusiveMaximum?: number;
  readonly multipleOf?: number;
}

export interface ArraySchemaOptions {
  readonly minItems?: number;
  readonly maxItems?: number;
  readonly uniqueItems?: boolean;
}

export type UnknownKeyPolicy = "strip" | "passthrough";

export interface ObjectSchemaOptions<K extends PropertyKey = string> {
  readonly optional?: readonly K[];
  /** Defaults to strip: model-added fields are ignored rather than treated as failures. */
  readonly unknownKeys?: UnknownKeyPolicy;
  readonly minProperties?: number;
  readonly maxProperties?: number;
}

export interface RecordSchemaOptions {
  readonly minProperties?: number;
  readonly maxProperties?: number;
}

type InferSchema<S> = S extends OutputSchema<infer T> ? T : never;

/** Adapt any Zod-like validator without making Zod a required dependency. */
export function fromZod<T>(validator: ZodLike<T>, name = "Output", jsonSchema?: JsonSchema): OutputSchema<T> {
  const schema = jsonSchema ?? validator.toJSONSchema?.() ?? {
    type: "object",
    description: "Provide a JSON schema for this validator to enable strict provider output."
  };
  return defineSchema(name, schema, (value) => validator.parse(value));
}

/** Build a schema from JSON Schema and validate it locally with detailed errors. */
export function fromJsonSchema<T = unknown>(name: string, jsonSchema: JsonSchema): OutputSchema<T> {
  return validatedSchema(name, jsonSchema, (value) => value as T);
}

export function stringSchema(options?: StringSchemaOptions): OutputSchema<string>;
export function stringSchema(name?: string, options?: StringSchemaOptions): OutputSchema<string>;
export function stringSchema(
  nameOrOptions: string | StringSchemaOptions = "String",
  maybeOptions: StringSchemaOptions = {}
): OutputSchema<string> {
  const name = typeof nameOrOptions === "string" ? nameOrOptions : "String";
  const options = typeof nameOrOptions === "string" ? maybeOptions : nameOrOptions;
  return fromJsonSchema(name, { type: "string", ...options });
}

export function numberSchema(options?: NumberSchemaOptions): OutputSchema<number>;
export function numberSchema(name?: string, options?: NumberSchemaOptions): OutputSchema<number>;
export function numberSchema(
  nameOrOptions: string | NumberSchemaOptions = "Number",
  maybeOptions: NumberSchemaOptions = {}
): OutputSchema<number> {
  const name = typeof nameOrOptions === "string" ? nameOrOptions : "Number";
  const options = typeof nameOrOptions === "string" ? maybeOptions : nameOrOptions;
  return fromJsonSchema(name, { type: options.integer ? "integer" : "number", ...options });
}

export function booleanSchema(name = "Boolean"): OutputSchema<boolean> {
  return fromJsonSchema(name, { type: "boolean" });
}

export function arraySchema<T>(
  item: OutputSchema<T>,
  name?: string,
  options?: ArraySchemaOptions
): OutputSchema<T[]> {
  const jsonSchema: JsonSchema = {
    type: "array",
    items: item.jsonSchema,
    ...(options ?? {})
  };
  return validatedSchema(name ?? "Array", jsonSchema, (value) => {
    if (!Array.isArray(value)) throw new TypeError("Expected an array");
    return value.map((itemValue) => item.parse(itemValue));
  });
}

export function objectSchema<T extends Record<string, unknown>>(
  name: string,
  properties: { readonly [K in keyof T]: OutputSchema<T[K]> },
  options: ObjectSchemaOptions<keyof T> = {}
): OutputSchema<T> {
  const optional = new Set<keyof T>(options.optional ?? []);
  const propertySchemas = Object.fromEntries(
    Object.entries(properties).map(([key, value]) => [key, value.jsonSchema])
  ) as Record<string, JsonSchema>;
  const required = Object.keys(properties).filter((key) => !optional.has(key as keyof T));
  const unknownKeys = options.unknownKeys ?? "strip";
  const jsonSchema: JsonSchema = {
    type: "object",
    properties: propertySchemas,
    required,
    additionalProperties: unknownKeys === "strip" ? false : true,
    ...(options.minProperties === undefined ? {} : { minProperties: options.minProperties }),
    ...(options.maxProperties === undefined ? {} : { maxProperties: options.maxProperties })
  };
  return validatedSchema(name, jsonSchema, (value) => {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      throw new TypeError(`Expected ${name} to be an object`);
    }
    const record = value as Record<string, unknown>;
    const output: Record<string, unknown> = unknownKeys === "passthrough" ? { ...record } : {};
    for (const [key, property] of Object.entries(properties)) {
      if (record[key] !== undefined) output[key] = property.parse(record[key]);
    }
    return output as T;
  });
}

export function enumSchema<const Values extends readonly JsonValue[]>(
  name: string,
  values: Values
): OutputSchema<Values[number]> {
  if (values.length === 0) throw new Error(`Enum schema "${name}" requires at least one value`);
  return fromJsonSchema<Values[number]>(name, { enum: values });
}

export function literalSchema<const Value extends JsonValue>(name: string, value: Value): OutputSchema<Value> {
  return fromJsonSchema<Value>(name, { const: value });
}

export function unionSchema<const Schemas extends readonly OutputSchema<unknown>[]>(
  name: string,
  schemas: Schemas
): OutputSchema<InferSchema<Schemas[number]>> {
  if (schemas.length === 0) throw new Error(`Union schema "${name}" requires at least one member`);
  return validatedSchema(name, { anyOf: schemas.map((schema) => schema.jsonSchema) }, (value) => {
    const failures: unknown[] = [];
    for (const schema of schemas) {
      try {
        return schema.parse(value) as InferSchema<Schemas[number]>;
      } catch (error) {
        failures.push(error);
      }
    }
    throw new SchemaValidationError(name, [{
      path: "$",
      keyword: "anyOf",
      message: `Expected one of ${schemas.map((schema) => schema.name).join(", ")}`
    }], failures);
  });
}

export function nullableSchema<T>(schema: OutputSchema<T>, name = `Nullable${schema.name}`): OutputSchema<T | null> {
  return validatedSchema(name, { anyOf: [schema.jsonSchema, { type: "null" }] }, (value) => {
    if (value === null) return null;
    return schema.parse(value);
  });
}

export function recordSchema<T>(
  valueSchema: OutputSchema<T>,
  name = "Record",
  options: RecordSchemaOptions = {}
): OutputSchema<Record<string, T>> {
  return validatedSchema(name, {
    type: "object",
    additionalProperties: valueSchema.jsonSchema,
    ...(options.minProperties === undefined ? {} : { minProperties: options.minProperties }),
    ...(options.maxProperties === undefined ? {} : { maxProperties: options.maxProperties })
  }, (value) => {
    const record = value as Record<string, unknown>;
    return Object.fromEntries(Object.entries(record).map(([key, item]) => [key, valueSchema.parse(item)]));
  });
}

export function tupleSchema<const Schemas extends readonly OutputSchema<unknown>[]>(
  items: Schemas,
  name = "Tuple"
): OutputSchema<{ [K in keyof Schemas]: InferSchema<Schemas[K]> }> {
  return validatedSchema(name, {
    type: "array",
    items: items.map((item) => item.jsonSchema),
    additionalItems: false,
    minItems: items.length,
    maxItems: items.length
  }, (value) => {
    const array = value as readonly unknown[];
    return items.map((item, index) => item.parse(array[index])) as { [K in keyof Schemas]: InferSchema<Schemas[K]> };
  });
}

/** Add a runtime predicate while retaining the wrapped schema for provider output. */
export function refineSchema<T>(
  schema: OutputSchema<T>,
  name: string,
  predicate: (value: T) => boolean,
  message = "Value failed the schema refinement"
): OutputSchema<T> {
  return defineSchema(name, schema.jsonSchema, (value) => {
    const parsed = schema.parse(value);
    if (!predicate(parsed)) {
      throw new SchemaValidationError(name, [{ path: "$", keyword: "refine", message }]);
    }
    return parsed;
  });
}

function validatedSchema<T>(
  name: string,
  jsonSchema: JsonSchema,
  transform: (value: unknown) => T
): OutputSchema<T> {
  const validate = compile(jsonSchema);
  return defineSchema(name, jsonSchema, (value) => {
    const candidate = cloneJsonValue(value);
    if (!validate(candidate)) {
      throw new SchemaValidationError(name, ajvIssues(validate.errors ?? []));
    }
    return transform(candidate);
  });
}

function compile(schema: JsonSchema): ValidateFunction {
  return jsonValidator.compile(schema as Record<string, unknown>);
}

function ajvIssues(errors: readonly ErrorObject[]): ValidationIssue[] {
  return errors.map((error) => {
    const basePath = pointerToPath(error.instancePath);
    const missing = error.keyword === "required" && typeof error.params.missingProperty === "string"
      ? error.params.missingProperty
      : undefined;
    const path = missing ? `${basePath}.${missing}` : basePath;
    return {
      path,
      keyword: error.keyword,
      message: friendlyAjvMessage(error),
      ...(error.params === undefined ? {} : { params: error.params })
    };
  });
}

function friendlyAjvMessage(error: ErrorObject): string {
  if (error.keyword === "type" && typeof error.params.type === "string") {
    const type = error.params.type;
    const article = /^[aeiou]/i.test(type) ? "an" : "a";
    return `Expected ${article} ${type}`;
  }
  return error.message ?? "value is invalid";
}

function pointerToPath(pointer: string): string {
  if (!pointer) return "$";
  return pointer.split("/").slice(1).reduce((path, segment) => {
    const decoded = segment.replaceAll("~1", "/").replaceAll("~0", "~");
    return /^\d+$/.test(decoded) ? `${path}[${decoded}]` : `${path}.${decoded}`;
  }, "$");
}

function cloneJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(cloneJsonValue);
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(Object.entries(value)
      .filter(([, item]) => item !== undefined)
      .map(([key, item]) => [key, cloneJsonValue(item)]));
  }
  return value;
}
