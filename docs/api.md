# API guide

## Schemas

An `OutputSchema<T>` has three pieces:

```ts
interface OutputSchema<T> {
  readonly name: string;
  readonly jsonSchema: JsonSchema;
  parse(value: unknown): T;
  parseJson(value: string): T;
}
```

Use a helper for simple values:

```ts
const score = numberSchema("Score");
const tags = arraySchema(stringSchema("Tag"), "Tags");
const answer = objectSchema("Answer", {
  text: stringSchema(),
  confidence: numberSchema()
});
```

For richer validation, use `defineSchema()` or adapt Zod with `fromZod()`. The parser is always called after a provider response, even if the provider claims to have enforced the schema.

## `llm()`

```ts
const answer = llm<[string], Answer>({
  name: "answerQuestion",
  system: "Answer concisely and cite the supplied context.",
  schema: answerSchema,
  prompt: ({ args, displayArgs, files, images }) => "...",
  provider: customProvider
});
```

The prompt callback receives the original arguments, a safe display representation, discovered file paths, and discovered data-URI/image inputs. Returning a schema makes the call structured; without one, the provider's text response is returned as `Result` and the caller should use `string` as the result type.

## `impl()`

`impl()` asks a provider for only a JavaScript function body. `parameters` are the names used in that body. The generated body is compiled once and stored in `FileCache` by default.

```ts
const normalize = impl<[string], string>({
  name: "normalize",
  parameters: ["value"],
  description: "Trim whitespace and collapse internal whitespace.",
  returnType: "string"
});
```

Pass `cache: false` to regenerate every process, or provide `MemoryCache` / another `Cache` implementation. Generated source should be reviewed and sandboxed when inputs are untrusted.

## `shim()`

`shim()` wraps an existing function. After an error it asks for a `RepairPlan`:

```ts
type RepairPlan = {
  strategy: "retry" | "rewrite";
  body?: string;
  explanation?: string;
};
```

`retry` invokes the original function again. `rewrite` compiles the supplied body with the declared `parameters` and invokes the replacement. `maxAttempts` defaults to two total calls.

## Provider interface

```ts
interface ModelProvider {
  generateText(request: GenerateRequest<never>): Promise<string>;
  generateStructured<T>(request: GenerateRequest<T>): Promise<T>;
}
```

This small interface makes unit tests straightforward and keeps transport concerns out of flow logic.

## Tasks

`runTask()` invokes the Codex CLI directly. `task()` turns an instruction builder into a reusable function:

```ts
const audit = task({
  name: "audit",
  instruction: ([directory]) => `Review ${directory} for security risks.`
});
const result = await audit("./src");
console.log(result.output, result.events, result.threadId);
```

Tasks retain parsed JSONL events and the final agent message. They are separate from `llm()`: tasks are coding-agent sessions, while `llm()` is a model function call.
