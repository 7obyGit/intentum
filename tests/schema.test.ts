import { describe, expect, it } from "vitest";
import {
  arraySchema,
  booleanSchema,
  defineSchema,
  enumSchema,
  fromJsonSchema,
  fromZod,
  literalSchema,
  nullableSchema,
  numberSchema,
  objectSchema,
  recordSchema,
  refineSchema,
  stringSchema,
  tupleSchema,
  unionSchema
} from "../src/schema.js";
import { SchemaValidationError } from "../src/types.js";

describe("schemas", () => {
  it("parses typed object output and rejects invalid fields", () => {
    const schema = objectSchema("Person", {
      name: stringSchema(),
      tags: arraySchema(stringSchema())
    });
    expect(schema.parse({ name: "Ada", tags: ["math"] })).toEqual({ name: "Ada", tags: ["math"] });
    expect(() => schema.parse({ name: 42, tags: [] })).toThrow("Expected a string");
    expect(schema.parseJson('{"name":"Grace","tags":[]}')).toEqual({ name: "Grace", tags: [] });
  });

  it("supports constraints, enums, and ignores model-added object fields", () => {
    const schema = objectSchema("Task", {
      status: enumSchema("Status", ["todo", "done"] as const),
      title: stringSchema("Title", { minLength: 3 })
    });
    expect(schema.parse({ status: "todo", title: "Ship it", unexpected: true })).toEqual({
      status: "todo",
      title: "Ship it"
    });
    expect(() => schema.parse({ status: "later", title: "Ship it" })).toThrow(SchemaValidationError);
    expect(() => schema.parse({ status: "todo", title: "x" })).toThrow("$.title");
  });

  it("supports unions, nullable values, tuples, records, and refinements", () => {
    const identifier = unionSchema("Identifier", [stringSchema(), numberSchema()] as const);
    expect(identifier.parse("abc")).toBe("abc");
    expect(identifier.parse(42)).toBe(42);
    expect(nullableSchema(literalSchema("Enabled", true)).parse(null)).toBeNull();

    const pair = tupleSchema([stringSchema(), numberSchema()] as const);
    expect(pair.parse(["count", 2])).toEqual(["count", 2]);

    const scores = recordSchema(numberSchema("Score", { minimum: 0 }), "Scores");
    expect(scores.parse({ ada: 10, grace: 9 })).toEqual({ ada: 10, grace: 9 });
    expect(() => scores.parse({ ada: -1 })).toThrow("$.ada");

    const nonEmpty = refineSchema(stringSchema(), "NonEmpty", (value) => value.length > 0, "Must not be empty");
    expect(() => nonEmpty.parse("")).toThrow("Must not be empty");
  });

  it("validates arbitrary complex JSON Schema locally with path-aware errors", () => {
    const schema = fromJsonSchema("Envelope", {
      type: "object",
      properties: {
        kind: { const: "event" },
        values: { type: "array", items: { type: "integer", minimum: 1 }, minItems: 1 }
      },
      required: ["kind", "values"],
      additionalProperties: false
    });
    expect(schema.parse({ kind: "event", values: [1, 2], ignored: "field" })).toEqual({ kind: "event", values: [1, 2] });
    try {
      schema.parse({ kind: "event", values: [0] });
      throw new Error("expected validation to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(SchemaValidationError);
      expect((error as SchemaValidationError).issues[0]?.path).toBe("$.values[0]");
    }
  });

  it("turns malformed JSON into a structured validation error", () => {
    const schema = stringSchema();
    expect(() => schema.parseJson("not-json")).toThrow(SchemaValidationError);
    expect(() => schema.parseJson("not-json")).toThrow("json");
  });

  it("supports optional and passthrough object properties without mutating input", () => {
    const input = { name: "Ada", extra: true };
    const optional = objectSchema("OptionalPerson", {
      name: stringSchema(),
      age: numberSchema()
    }, { optional: ["age"] });
    expect(optional.parse(input)).toEqual({ name: "Ada" });
    expect(input).toEqual({ name: "Ada", extra: true });

    const passthrough = objectSchema("PassthroughPerson", {
      name: stringSchema()
    }, { unknownKeys: "passthrough" });
    expect(passthrough.parse(input)).toEqual(input);
  });

  it("enforces primitive, collection, and string constraints", () => {
    const integer = numberSchema("Integer", { integer: true, minimum: 1, maximum: 10, multipleOf: 2 });
    expect(integer.parse(4)).toBe(4);
    for (const value of [0, 3, 11, 1.5]) expect(() => integer.parse(value)).toThrow(SchemaValidationError);

    const items = arraySchema(stringSchema(), "Items", { minItems: 2, maxItems: 3, uniqueItems: true });
    expect(items.parse(["a", "b"])).toEqual(["a", "b"]);
    expect(() => items.parse(["a"])).toThrow("fewer than 2 items");
    expect(() => items.parse(["a", "a"])).toThrow("duplicate");

    const slug = stringSchema("Slug", { pattern: "^[a-z-]+$", minLength: 2, maxLength: 8 });
    expect(() => slug.parse("hello-world")).toThrow("more than 8 characters");
    expect(() => slug.parse("A")).toThrow("pattern");
    expect(() => slug.parse("valid-slug-too-long")).toThrow("more than 8 characters");
    expect(booleanSchema().parse(true)).toBe(true);
  });

  it("reports all nested validation issues with useful keywords", () => {
    const schema = objectSchema("Profile", {
      name: stringSchema("Name", { minLength: 3 }),
      tags: arraySchema(stringSchema("Tag", { minLength: 2 }), "Tags")
    });
    try {
      schema.parse({ name: "x", tags: ["ok", "y"] });
      throw new Error("expected validation to fail");
    } catch (error) {
      const validation = error as SchemaValidationError;
      expect(validation.issues).toEqual(expect.arrayContaining([
        expect.objectContaining({ path: "$.name", keyword: "minLength" }),
        expect.objectContaining({ path: "$.tags[1]", keyword: "minLength" })
      ]));
      expect(validation.schemaName).toBe("Profile");
      expect(validation.message).toContain("$.tags[1]");
    }
  });

  it("supports JSON Schema composition, references, and property rules", () => {
    const schema = fromJsonSchema("Complex", {
      $defs: { positive: { type: "integer", minimum: 1 } },
      type: "object",
      properties: {
        id: { $ref: "#/$defs/positive" },
        mode: { oneOf: [{ const: "fast" }, { const: "safe" }] },
        payload: {
          allOf: [{ type: "object" }, { minProperties: 1 }],
          patternProperties: { "^x-": { type: "string" } },
          additionalProperties: false,
          propertyNames: { pattern: "^x-" }
        },
        values: { type: "array", contains: { const: "required" } }
      },
      required: ["id", "mode", "payload", "values"]
    });
    expect(schema.parse({ id: 1, mode: "safe", payload: { "x-note": "ok" }, values: ["required"] })).toEqual({
      id: 1,
      mode: "safe",
      payload: { "x-note": "ok" },
      values: ["required"]
    });
    expect(() => schema.parse({ id: 0, mode: "unknown", payload: {}, values: ["other"] })).toThrow(SchemaValidationError);
  });

  it("adapts Zod-like parsers and normalizes custom parser issues", () => {
    const validator = {
      toJSONSchema: () => ({ type: "string", minLength: 2 }),
      parse(value: unknown): string {
        if (typeof value !== "string" || value.length < 2) {
          throw { issues: [{ path: ["user", 0, "name"], code: "too_small", message: "Name is too short" }] };
        }
        return value.toUpperCase();
      }
    };
    const schema = fromZod(validator, "Name");
    expect(schema.parse("ada")).toBe("ADA");
    expect(() => schema.parse("x")).toThrow("$.user[0].name");

    const fallback = fromZod({ parse: (value: unknown) => value as number }, "Fallback");
    expect(fallback.jsonSchema.description).toContain("Provide a JSON schema");

    const custom = defineSchema("Custom", { type: "string" }, () => {
      throw new Error("custom failure");
    });
    expect(() => custom.parse("value")).toThrow("custom failure");
    expect(() => custom.parse("value")).toThrow(SchemaValidationError);
  });

  it("rejects invalid helper definitions early", () => {
    expect(() => enumSchema("Empty", [])).toThrow("at least one value");
    expect(() => unionSchema("Empty", [])).toThrow("at least one member");
  });
});
