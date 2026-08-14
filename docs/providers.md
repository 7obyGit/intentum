# Providers and structured output

## OpenAI-compatible HTTP

`OpenAICompatibleProvider` calls `POST {baseURL}/chat/completions`. Configure it with constructor options or environment variables:

| Variable | Purpose | Default |
| --- | --- | --- |
| `INTENTUM_API_KEY` | API credential | `OPENAI_API_KEY` |
| `INTENTUM_BASE_URL` | API root | `https://api.openai.com/v1` |
| `INTENTUM_MODEL` | Chat model | `gpt-4o-mini` |
| `INTENTUM_PROVIDER` | `openai` or `codex` | `auto` / OpenAI-compatible |

Structured requests use the provider's native `response_format: { type: "json_schema", ... }` shape and then call `schema.parseJson()` locally. Images are sent as data URLs.

## Codex CLI

`CodexProvider` runs:

```text
codex exec --json --ephemeral --sandbox workspace-write \
  --output-schema /tmp/schema.json \
  --output-last-message /tmp/output.json \
  "..."
```

The schema and output files are temporary. Event JSONL is parsed into `CodexEvent` records, and the final `agent_message` becomes `output`. Set `INTENTUM_CODEX_MODEL`, pass `cwd`, or choose `read-only` for a safer task workspace.

The CLI must already be installed and authenticated. Intentum does not install or configure Codex for you.

## Mocks and custom providers

Use `MockProvider` for deterministic tests:

```ts
const provider = new MockProvider({
  text: "return value.toUpperCase();",
  structured: { title: "fixture", keyPoints: ["stable"] }
});
```

For another transport, implement `ModelProvider`. This is also the recommended way to add retries, tracing, rate limiting, or a provider-specific response format at the application boundary.

## Safety

Structured output validates data shape; it does not make prompts or generated code safe. Keep API credentials outside source control, use read-only Codex sandboxes where possible, and execute model-generated code in a worker or sandbox for untrusted input.
