# Intentum

Intentum turns typed intent into executable behavior. It is a small TypeScript runtime for model-backed functions, generated implementations, self-repair, and observable workflows.

The package is deliberately provider-agnostic. It can call any OpenAI-compatible chat endpoint, use the Codex CLI (including its native JSON Schema output mode), or use a deterministic mock provider in tests.

## What is included

- `llm()` — define text or schema-constrained model functions.
- `impl()` — generate a JavaScript function body from a specification and cache it.
- `shim()` — recover from failures with a model-assisted retry or replacement plan.
- `flow()` — make synchronous and asynchronous functions inspectable runs.
- `step()` and `retry()` — record meaningful operations, attempts, timings, and failures.
- `runTask()` / `task()` — launch non-interactive Codex tasks and retain JSONL events.
- `defineSchema()` and schema helpers — keep structured output runtime-validated and statically typed.
- `FileCache` / `MemoryCache` — choose persistent or deterministic generated-code caching.

Intentum does not hide ordinary TypeScript control flow. A flow is still a function, a model call is still asynchronous, and a step is an explicit boundary you choose to observe.

## Install

```bash
npm install intentum
```

Intentum requires Node.js 20 or newer. Build from source with `npm run check`.

## Configure a provider

For an OpenAI-compatible endpoint:

```bash
export INTENTUM_API_KEY="..."
export INTENTUM_BASE_URL="https://api.openai.com/v1" # optional
export INTENTUM_MODEL="gpt-4o-mini"                    # optional
export INTENTUM_PROVIDER="openai"                     # optional; this is the default
```

To use an installed Codex CLI:

```bash
export INTENTUM_PROVIDER="codex"
export INTENTUM_CODEX_MODEL="gpt-5.3-codex" # optional
```

The provider is injectable everywhere, so tests do not need credentials. See [provider configuration](docs/providers.md).

## A structured model function

```ts
import { llm, MockProvider, objectSchema, stringSchema, arraySchema } from "intentum";

const summarySchema = objectSchema("Summary", {
  title: stringSchema(),
  keyPoints: arraySchema(stringSchema())
});

const summarize = llm<[string], { title: string; keyPoints: string[] }>({
  schema: summarySchema,
  provider: new MockProvider({
    structured: { title: "Intentum", keyPoints: ["Typed", "Observable"] }
  }),
  prompt: ({ args }) => `Summarize this document: ${args[0]}`
});

const result = await summarize("Intentum is a TypeScript runtime.");
```

The OpenAI-compatible provider sends the schema as `response_format.json_schema`. The Codex provider writes the schema to a temporary file and invokes `codex exec --output-schema ...`, then validates the returned JSON through the same schema.

## Observable workflows

```ts
import { flow, retry, step } from "intentum";

const research = flow(async (topic: string) => {
  const plan = await step(() => makePlan(topic), { name: "plan" });
  return Promise.all(plan.items.map((item) => retry(
    { attempts: 3, delayMs: 250, backoff: 2 },
    () => researchItem(item),
    { name: `research:${item}` }
  )));
}, { silent: false });

const run = research("typed workflow libraries");
console.log(await run.result());
console.log(run.status, run.steps);
```

Every call returns a `FlowRun`: it has a status, timing, error, child step records, `result()` / `promise`, cooperative `stop()`, and whole-run `retry()` after failure. Read [the flow guide](docs/flows.md) for async behavior and cancellation.

## Generated implementations and repair

```ts
const slugify = impl<[string], string>({
  name: "slugify",
  parameters: ["value"],
  description: "Convert arbitrary text to a lowercase URL slug separated by hyphens.",
  returnType: "string",
  provider: new MockProvider({ text: "return value.trim().toLowerCase().replaceAll(/[^a-z0-9]+/g, \"-\");" }),
  cache: new MemoryCache()
});

const safeParse = shim({
  name: "parseJson",
  parameters: ["input"],
  fn: (input: string) => JSON.parse(input) as unknown,
  provider: new MockProvider({
    structured: { strategy: "rewrite", body: "return JSON.parse(input.replaceAll(\"'\", '\"'));" }
  })
});
```

Generated source is intentionally explicit and cacheable. Treat model-generated code as code: run it in a constrained process for untrusted prompts and review cached implementations before production use.

## Documentation and examples

- [Documentation index](docs/README.md)
- [API guide](docs/api.md)
- [Providers and structured output](docs/providers.md)
- [Typed flows](docs/flows.md)
- [Examples guide](docs/examples.md)
- Runnable source examples in [`examples/`](examples/)

## Project status

Intentum is an initial working base for review. The API is intentionally small and explicit; persistence, distributed workers, model-specific tool calling, and a full sandbox are future concerns rather than hidden behavior in this first release.

```bash
npm run check
```
