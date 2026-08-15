# Providers and structured output

## OpenAI-compatible HTTP

`OpenAICompatibleProvider` calls `POST {baseURL}/chat/completions`. Configure it with constructor options or environment variables:

| Variable | Purpose | Default |
| --- | --- | --- |
| `INTENTUM_API_KEY` | API credential | `OPENAI_API_KEY` |
| `INTENTUM_BASE_URL` | API root | `https://api.openai.com/v1` |
| `INTENTUM_MODEL` | Chat model | `gpt-4o-mini` |
| `INTENTUM_LOCAL_BASE_URL` | Local OpenAI-compatible API root | auto-detected Ollama/LM Studio URLs |
| `INTENTUM_LOCAL_MODEL` | Local model name | `llama3.2` |
| `INTENTUM_PROVIDER` | `auto`, `openai`, `codex`, or `local` | `auto` |
| `INTENTUM_INTELLIGENCE` | `LOW`, `MEDIUM`, or `HIGH` | unset |

Structured requests use the provider's native `response_format: { type: "json_schema", ... }` shape and then call `schema.parseJson()` locally. Images are sent as data URLs. A failed local parse is surfaced as `StructuredOutputError`; `llm()` can use its path-aware details to request corrected JSON automatically.

HTTP providers have a 30-second timeout by default, retry transient network, 408/409/425, 429, and 5xx failures with exponential backoff, honor `Retry-After`, and expose typed `ProviderError` values. Configure `maxRetries`, `retryDelayMs`, `retryBackoff`, `retryJitter`, and `timeoutMs`. `onResponse` receives latency, finish reason, request ID, and token usage when the endpoint provides them.

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

### Automatic provider selection

`createProvider()` and `providerFromEnvironment()` default to `auto`. The order is:

1. an available Codex executable;
2. a reachable `INTENTUM_LOCAL_BASE_URL`, or Ollama (`11434`) / LM Studio (`1234`);
3. a cloud OpenAI-compatible endpoint when `INTENTUM_API_KEY` or `OPENAI_API_KEY` is set.

Use `INTENTUM_PROVIDER=openai|codex|local` to force a provider. Set `INTENTUM_INTELLIGENCE=LOW|MEDIUM|HIGH`, or pass `intelligence`, to select `Luna Low`, `Luna High`, or `Sol High` respectively. An explicit `model` still takes precedence.

## Safety

Structured output validates data shape; it does not make prompts or generated code safe. Keep API credentials outside source control, use read-only Codex sandboxes where possible, and execute model-generated code in a worker or sandbox for untrusted input.
