import { describe, expect, it } from "vitest";
import {
  arraySchema,
  enumSchema,
  fromJsonSchema,
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
});
