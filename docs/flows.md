# Typed flows

## A flow run

`flow()` accepts an ordinary synchronous or asynchronous function and returns a callable that produces a `FlowRun`.

```ts
const prepare = flow((name: string) => {
  return step(() => name.trim(), { name: "trim" });
}, { silent: true });

const run = prepare(" Ada ");
console.log(run.status);          // pending or running
console.log(await run.result());  // Ada
console.log(run.status);          // succeeded
console.log(run.durationMs);
```

`result()`, `wait()`, and `promise` all resolve the typed result. Failures are recorded on the run and re-thrown by `result()`, which lets callers inspect `run.error` and `run.steps` first.

## Steps

Call `step()` only inside an active flow. It records start, success, failure, and elapsed time. A step can be synchronous or return a promise:

```ts
const pipeline = flow(async (input: string) => {
  const cleaned = step(() => input.trim(), { name: "clean" });
  const enriched = await step(() => fetchMetadata(cleaned), { name: "metadata" });
  return { cleaned, enriched };
}, { silent: true });
```

Calling `step()` outside a flow throws, because there is no run in which to record it.

## Retries

`retry()` records each attempt as part of one step:

```ts
const robust = flow(async () => retry(
  { attempts: 3, delayMs: 100, backoff: 2 },
  () => unreliableRequest(),
  { name: "request" }
), { silent: true });
```

`attempts` is the total number of calls, not the number of retries after the first call. Delays are cooperative and stop-aware.

## Cancellation and restart

```ts
const run = robust();
run.stop(); // requests cooperative cancellation

try {
  await run.result();
} catch (error) {
  if (run.status === "stopped") {
    const restarted = run.retry();
    await restarted.result();
  }
}
```

JavaScript cannot safely interrupt arbitrary synchronous work. Intentum checks cancellation before steps, between retries, after retry delays, and before publishing a successful result.

## Events

Provide `onEvent` to integrate with logs or tracing:

```ts
const events: FlowEvent[] = [];
const tracked = flow(work, { silent: true, onEvent: (event) => events.push(event) });
```

Without `silent: true`, Intentum prints compact lifecycle messages. The callback receives structured flow, step, and attempt events independently of console output.

## Composition

Flows can be called from steps and awaited like any other operation. A parent flow does not automatically absorb a child run's internal steps unless the child invocation is itself wrapped in a parent `step()`; this keeps composition explicit and avoids hidden graph edges.
