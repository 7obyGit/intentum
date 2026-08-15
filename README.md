# Intentum

![CI](https://github.com/7obyGit/intentum/actions/workflows/ci.yml/badge.svg)
[![npm version](https://img.shields.io/npm/v/intentum.svg)](https://www.npmjs.com/package/intentum)
[![License](https://img.shields.io/npm/l/intentum.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/node-%3E%3D20-339933.svg?logo=node.js&logoColor=white)](https://nodejs.org/)

Typed, observable AI functions and resilient workflows for TypeScript.

Intentum gives model-backed behavior a small, explicit runtime boundary. Define a typed model function, validate its structured response, observe important workflow steps, retry transient work, or generate a reviewable implementation that can be cached and repaired.

```text
your TypeScript
      │
      ├── llm()       typed model calls + schema validation + repair
      ├── impl()      generated function bodies + caching
      ├── shim()      model-assisted retry or source replacement
      ├── flow()      observable execution + steps + retries
      └── task()      non-interactive Codex CLI sessions
```

## Why Intentum?

- **Types at the boundary** — pair TypeScript inference with runtime JSON Schema validation.
- **Provider choice without lock-in** — use Codex, any OpenAI-compatible endpoint, a local model, or a deterministic mock.
- **Recovery with evidence** — structured failures include paths, validation details, and the invalid response so a model can correct it.
- **Observable by design** — inspect status, timing, attempts, errors, and lifecycle events without instrumenting every function.
- **Reviewable generation** — generated code is explicit, cacheable, and treated as code rather than hidden magic.
- **Testable locally** — inject `MockProvider`; no credentials or network are required for unit tests.

## Install

```bash
npm install intentum
```

Intentum supports Node.js 20 and newer and ships as an ESM package with TypeScript declarations.

## Quick start

```ts
import {
  MockProvider,
  arraySchema,
  llm,
  objectSchema,
  stringSchema
} from "intentum";

const summarySchema = objectSchema("Summary", {
  title: stringSchema(),
  keyPoints: arraySchema(stringSchema())
});

const summarize = llm<[string], { title: string; keyPoints: string[] }>({
  schema: summarySchema,
  provider: new MockProvider({
    structured: {
      title: "Intentum",
      keyPoints: ["Typed", "Observable", "Resilient"]
    }
  }),
  prompt: ({ args }) => `Summarize this document: ${args[0]}`
});

const result = await summarize("Intentum is a TypeScript runtime.");
// { title: "Intentum", keyPoints: ["Typed", "Observable", "Resilient"] }
```

Replace `MockProvider` with the default provider selection when your application is configured. Intentum checks for Codex first, then reachable local OpenAI-compatible servers, then a configured cloud endpoint.

## Choose a model capability

Use the portable `intelligence` setting instead of coupling application code to a provider-specific model name:

```ts
const answer = llm<[], string>({
  intelligence: "HIGH",
  prompt: () => "Give a concise answer."
});
```

| Intelligence | Built-in model mapping |
| --- | --- |
| `LOW` | `Luna Low` |
| `MEDIUM` | `Luna High` |
| `HIGH` | `Sol High` |

The default is `MEDIUM`. Set `INTENTUM_INTELLIGENCE` or provide an explicit model when needed.

## Configure providers

```bash
# Automatic selection is the default.
export INTENTUM_PROVIDER=auto
export INTENTUM_API_KEY="..."

# Or force one route.
export INTENTUM_PROVIDER=codex
# export INTENTUM_PROVIDER=local
# export INTENTUM_LOCAL_BASE_URL=http://127.0.0.1:11434/v1
```

The Codex CLI must already be installed and authenticated. OpenAI-compatible providers accept `INTENTUM_BASE_URL`, `INTENTUM_MODEL`, and the retry/timeout options documented in [Provider configuration](docs/providers.md).

## Build observable workflows

```ts
import { flow, retry, step } from "intentum";

const research = flow(async (topic: string) => {
  const cleaned = step(() => topic.trim(), { name: "clean" });
  return retry(
    { attempts: 3, delayMs: 250, backoff: 2 },
    () => fetchResearch(cleaned),
    { name: "research" }
  );
}, { silent: true });

const run = research("typed workflow libraries");
const result = await run.result();
console.log(run.status, run.steps, result);
```

Flows remain ordinary functions. Only the boundaries you mark with `step()` and `retry()` become observable.

## Structured schemas and recovery

Built-in helpers cover enums, literals, unions, nullable values, tuples, records, refinements, and constraints. `fromJsonSchema()` accepts complex JSON Schema, and `fromZod()` adapts a Zod-like parser without making Zod a dependency.

Unknown object fields are stripped by default so harmless model additions do not fail a request. Use `unknownKeys: "passthrough"` to retain them. Validation errors are path-aware, for example `$.items[2].name`.

When a structured response is invalid, `llm()` includes the validation error and previous output in a repair prompt and retries once by default:

```ts
import { enumSchema, llm, objectSchema } from "intentum";

const robustAnswer = llm<[], { action: "allow" | "deny" }>({
  schema: objectSchema("Decision", {
    action: enumSchema("Action", ["allow", "deny"] as const)
  }),
  repair: { maxAttempts: 3 },
  prompt: () => "Choose whether this request is allowed."
});
```

Authentication, cancellation, and ordinary transport failures retain their original error semantics; only structured parse/validation failures are repaired.

## Generated behavior

```ts
const slugify = impl<[string], string>({
  name: "slugify",
  parameters: ["value"],
  description: "Convert text to a lowercase URL slug separated by hyphens.",
  returnType: "string"
});
```

`impl()` caches the generated JavaScript body by default. `shim()` can retry a failing function or compile a model-provided replacement body. Generated code executes in the current process: review it and use a worker or sandbox for untrusted prompts.

## Documentation

| Guide | What it covers |
| --- | --- |
| [Documentation home](docs/README.md) | Product map and design principles |
| [API guide](docs/api.md) | Schemas, `llm`, `impl`, `shim`, providers, and tasks |
| [Provider configuration](docs/providers.md) | Auto-detection, Codex, HTTP retries, and safety |
| [Typed flows](docs/flows.md) | Steps, retries, cancellation, and events |
| [Examples](docs/examples.md) | Runnable examples in [`examples/`](examples/) |
| [Releasing](docs/releasing.md) | npm release checklist and trusted publishing |
| [Contributing](CONTRIBUTING.md) | Branch, PR, review, and local workflow |

## Development

```bash
npm ci
npm run check
npm run coverage
npm run package:check
```

If you use the [`aw` CLI](https://github.com/7obyGit/aw), the same workflows are available as:

```bash
aw run check
aw run coverage
aw run package:check
aw run audit
```

See [CONTRIBUTING.md](CONTRIBUTING.md) before opening a pull request.

## Project status

Intentum is a focused, actively evolving runtime. The API is deliberately explicit: distributed workers, provider-specific tool calling, and a full code sandbox are outside the package’s current boundary rather than hidden behind it.

## License

MIT © 7obyGit
