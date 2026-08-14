import { describe, expect, it } from "vitest";
import { arraySchema, objectSchema, stringSchema } from "../src/schema.js";

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
});
