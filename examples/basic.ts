import { llm, MockProvider, objectSchema, stringSchema, arraySchema } from "intentum";

const summarySchema = objectSchema("Summary", {
  title: stringSchema(),
  keyPoints: arraySchema(stringSchema())
});

export const summarize = llm<[string], { title: string; keyPoints: string[] }>({
  schema: summarySchema,
  provider: new MockProvider({
    structured: { title: "Intentum", keyPoints: ["Typed output", "Provider independence"] }
  }),
  prompt: ({ args }) => `Summarize: ${args[0]}`
});

const result = await summarize("Intentum turns intent into executable behavior.");
console.log(result);
