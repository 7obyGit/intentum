import { defineSchema, type JsonSchema, type OutputSchema } from "./types.js";

export { defineSchema } from "./types.js";
export type { JsonSchema, OutputSchema } from "./types.js";

export interface ZodLike<T> {
  parse(value: unknown): T;
  toJSONSchema?: () => JsonSchema;
  _def?: unknown;
}

/** Adapt any Zod-like validator without making Zod a required dependency. */
export function fromZod<T>(validator: ZodLike<T>, name = "Output"): OutputSchema<T> {
  const jsonSchema = validator.toJSONSchema?.() ?? {
    type: "object",
    description: "Provide a JSON schema for this validator to enable strict provider output."
  };
  return defineSchema(name, jsonSchema, (value) => validator.parse(value));
}

export function stringSchema(name = "String"): OutputSchema<string> {
  return defineSchema(name, { type: "string" }, (value) => {
    if (typeof value !== "string") throw new TypeError("Expected a string");
    return value;
  });
}

export function numberSchema(name = "Number"): OutputSchema<number> {
  return defineSchema(name, { type: "number" }, (value) => {
    if (typeof value !== "number" || !Number.isFinite(value)) throw new TypeError("Expected a finite number");
    return value;
  });
}

export function booleanSchema(name = "Boolean"): OutputSchema<boolean> {
  return defineSchema(name, { type: "boolean" }, (value) => {
    if (typeof value !== "boolean") throw new TypeError("Expected a boolean");
    return value;
  });
}

export function arraySchema<T>(item: OutputSchema<T>, name = "Array"): OutputSchema<T[]> {
  return defineSchema(name, { type: "array", items: item.jsonSchema }, (value) => {
    if (!Array.isArray(value)) throw new TypeError("Expected an array");
    return value.map((itemValue) => item.parse(itemValue));
  });
}

export function objectSchema<T extends Record<string, unknown>>(
  name: string,
  properties: { readonly [K in keyof T]: OutputSchema<T[K]> },
  options: { readonly optional?: readonly (keyof T)[] } = {}
): OutputSchema<T> {
  const optional = new Set<keyof T>(options.optional ?? []);
  const propertySchemas = Object.fromEntries(
    Object.entries(properties).map(([key, value]) => [key, value.jsonSchema])
  ) as Record<string, JsonSchema>;
  const required = Object.keys(properties).filter((key) => !optional.has(key as keyof T));
  return defineSchema(name, {
    type: "object",
    properties: propertySchemas,
    required,
    additionalProperties: false
  }, (value) => {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      throw new TypeError(`Expected ${name} to be an object`);
    }
    const record = value as Record<string, unknown>;
    const output: Record<string, unknown> = {};
    for (const [key, property] of Object.entries(properties)) {
      if (record[key] === undefined && !optional.has(key as keyof T)) {
        throw new TypeError(`Missing required property: ${key}`);
      }
      if (record[key] !== undefined) output[key] = property.parse(record[key]);
    }
    return output as T;
  });
}
