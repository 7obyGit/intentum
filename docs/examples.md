# Examples

The `examples/` directory is intentionally small enough to read in one sitting:

- `basic.ts` — schema-constrained `llm()` with a deterministic mock.
- `flows.ts` — steps, retries, events, and a typed `FlowRun`.
- `generation.ts` — cached `impl()` and model-assisted `shim()`.
- `codex.ts` — native Codex structured output and task invocation.

Run the examples after building with a TypeScript runner such as `tsx`, or copy them into an application that already has a TypeScript execution setup. They use only the public package API.

The examples intentionally inject `MockProvider` for model functions so they can be read and tested without credentials. The Codex example is opt-in and expects an authenticated `codex` executable.
