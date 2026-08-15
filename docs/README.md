# Intentum documentation

Intentum is the runtime layer between a TypeScript application and model-backed behavior. These guides explain the public API, provider lifecycle, validation guarantees, and the project workflow used to keep releases dependable.

## Choose a path

| You want to… | Start with… |
| --- | --- |
| Call a model with typed structured output | [API guide — `llm()`](api.md#llm) |
| Validate enums, unions, records, tuples, or JSON Schema | [API guide — schemas](api.md#schemas) |
| Select Codex, a local model, or HTTP automatically | [Provider configuration](providers.md) |
| Track steps, retries, timing, or cancellation | [Typed flows](flows.md) |
| Generate and repair a function body | [API guide — generation](api.md#impl) |
| Launch a non-interactive Codex task | [API guide — tasks](api.md#tasks) |
| Run the project or prepare an npm release | [Contributing](../CONTRIBUTING.md) and [Releasing](releasing.md) |

## The design in one minute

```text
OutputSchema<T>  →  validate model data locally
ModelProvider    →  isolate transport and model selection
llm()            →  typed model function with structured repair
flow()           →  observable execution boundary
impl()/shim()    →  explicit generated behavior and recovery
```

## Design principles

### Explicit boundaries

Intentum does not instrument every function call. `step()` and `retry()` mark the operations that matter, keeping ordinary branching, loops, and data transformations idiomatic TypeScript.

### Types plus runtime validation

TypeScript types disappear at runtime, so structured model output needs a validator. `OutputSchema<T>` pairs a JSON Schema with `parse()` and `parseJson()`. Built-in helpers cover common cases; `fromZod()` adapts a Zod-like validator without making Zod a required dependency.

### Provider independence

`ModelProvider` is the seam between runtime behavior and model transport. The built-in providers cover Codex, OpenAI-compatible APIs, automatic selection, and deterministic tests. Applications can implement the same two-method interface for another service.

### Reviewable generation

`impl()` caches generated function bodies rather than silently rewriting code on every call. `shim()` requests a typed repair plan and only replaces code when the model explicitly chooses `rewrite`.

## Scope and safety boundaries

Flows are local and in-memory. Cancellation is cooperative: JavaScript cannot safely terminate arbitrary synchronous work. Generated code runs in the current process; use a worker or sandbox when prompts or generated source are not trusted. Structured output validates shape, not intent or safety.

## Examples

The [`examples/`](../examples/) directory contains small, provider-injectable TypeScript programs:

- `basic.ts` — schema-constrained `llm()` with `MockProvider`.
- `flows.ts` — steps, retries, events, and a typed `FlowRun`.
- `generation.ts` — cached `impl()` and model-assisted `shim()`.
- `codex.ts` — native Codex structured output and task invocation.

See [Examples](examples.md) for execution notes.
