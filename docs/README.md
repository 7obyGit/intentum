# Intentum documentation

Intentum is a typed runtime for turning descriptions and model responses into ordinary TypeScript functions and observable workflows.

## Start here

1. Read the [API guide](api.md) for the public primitives.
2. Configure an [OpenAI-compatible or Codex provider](providers.md).
3. Learn how [flows, steps, retries, and cancellation](flows.md) behave.
4. Run the [examples](examples.md) and inspect the source in `examples/`.

## Design principles

### Explicit boundaries

Intentum never instruments every function call. `step()` and `retry()` mark the operations that matter to a workflow, keeping normal branching, loops, and data transformations idiomatic TypeScript.

### Types plus runtime validation

TypeScript types disappear at runtime, so structured model output needs a validator. `OutputSchema<T>` pairs a JSON Schema with a `parse()` function. The built-in helpers cover common cases, and `fromZod()` adapts a Zod-like validator without making Zod a required dependency.

### Provider independence

`ModelProvider` is the seam between runtime behavior and model transport. `OpenAICompatibleProvider`, `CodexProvider`, and `MockProvider` are included, but an application can implement the two-method interface for another service.

### Reviewable generation

`impl()` caches generated function bodies rather than silently rewriting code on every call. `shim()` asks for a structured repair plan and only replaces code when the model explicitly chooses `rewrite`.

## Scope boundaries

Flows are local and in-memory. A stopped synchronous operation is cooperative: Intentum checks for cancellation at step and retry boundaries, but JavaScript cannot safely terminate arbitrary synchronous code. Generated code runs in the current process; use a worker or sandbox when prompts are not trusted.
