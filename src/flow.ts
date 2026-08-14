import { AsyncLocalStorage } from "node:async_hooks";
import type { Awaitable } from "./types.js";

export type RunStatus = "pending" | "running" | "succeeded" | "failed" | "stopped";

export class FlowStoppedError extends Error {
  constructor(message = "Flow was stopped") {
    super(message);
    this.name = "FlowStoppedError";
  }
}

export interface RetryPolicy {
  readonly attempts: number;
  readonly delayMs?: number;
  readonly backoff?: number;
}

export interface AttemptRun {
  readonly index: number;
  readonly startedAt: number;
  readonly durationMs?: number | undefined;
  readonly status: "running" | "succeeded" | "failed" | "stopped";
  readonly error?: unknown | undefined;
}

export interface StepRun {
  readonly name: string;
  readonly startedAt: number;
  readonly durationMs?: number | undefined;
  readonly status: RunStatus;
  readonly attempts: readonly AttemptRun[];
  readonly error?: unknown | undefined;
}

export interface FlowEvent {
  readonly type: "flow" | "step" | "attempt";
  readonly phase: "started" | "succeeded" | "failed" | "stopped" | "retrying";
  readonly name: string;
  readonly run: FlowRun<unknown, any>;
  readonly step?: StepRun;
  readonly attempt?: AttemptRun;
  readonly message?: string;
}

export interface FlowOptions {
  readonly name?: string;
  readonly silent?: boolean;
  readonly onEvent?: (event: FlowEvent) => void;
}

const activeRun = new AsyncLocalStorage<FlowRun<unknown, any>>();

export class FlowRun<Result, Args extends readonly unknown[] = readonly unknown[]> {
  readonly startedAt = Date.now();
  readonly steps: StepRun[] = [];
  status: RunStatus = "pending";
  error: unknown;
  private finishedAt?: number;
  private stopRequested = false;
  private readonly completion: Promise<void>;
  private readonly executeFunction: (...args: Args) => Awaitable<Result>;
  private readonly args: Args;
  private readonly flowName: string;
  private readonly options: FlowOptions;

  constructor(
    executeFunction: (...args: Args) => Awaitable<Result>,
    args: Args,
    flowName: string,
    options: FlowOptions
  ) {
    this.executeFunction = executeFunction;
    this.args = args;
    this.flowName = flowName;
    this.options = options;
    this.completion = this.execute();
  }

  get name(): string { return this.flowName; }
  get durationMs(): number | undefined {
    return this.finishedAt === undefined ? undefined : this.finishedAt - this.startedAt;
  }

  async result(): Promise<Result> {
    await this.completion;
    if (this.status === "stopped") throw this.error instanceof Error ? this.error : new FlowStoppedError();
    if (this.status === "failed") throw this.error instanceof Error ? this.error : new Error(String(this.error));
    return this.resultValue as Result;
  }

  get promise(): Promise<Result> { return this.result(); }

  async wait(): Promise<Result> { return this.result(); }

  stop(): boolean {
    if (this.status === "succeeded" || this.status === "failed" || this.status === "stopped") return false;
    this.stopRequested = true;
    if (this.status === "pending") this.status = "stopped";
    this.emit({ type: "flow", phase: "stopped", name: this.flowName, run: this as unknown as FlowRun<unknown, any> });
    return true;
  }

  retry(): FlowRun<Result, Args> {
    if (this.status !== "failed" && this.status !== "stopped") throw new Error("Only failed or stopped runs can be retried");
    return new FlowRun(this.executeFunction, this.args, this.flowName, this.options);
  }

  beginStep(name: string): InternalStep {
    const step = new InternalStep(name, this, this.steps.length);
    this.steps.push(step.snapshot());
    this.emit({ type: "step", phase: "started", name, run: this as unknown as FlowRun<unknown, any>, step: step.snapshot() });
    return step;
  }

  updateStep(index: number, snapshot: StepRun): void {
    this.steps[index] = snapshot;
  }

  isStopRequested(): boolean { return this.stopRequested; }

  private resultValue?: Result;

  private async execute(): Promise<void> {
    this.status = "running";
    this.emit({ type: "flow", phase: "started", name: this.flowName, run: this as unknown as FlowRun<unknown, any> });
    try {
      if (this.stopRequested) throw new FlowStoppedError();
      const result = await activeRun.run(this as unknown as FlowRun<unknown, any>, async () => this.executeFunction(...this.args));
      if (this.stopRequested) throw new FlowStoppedError();
      this.resultValue = result;
      this.status = "succeeded";
      this.emit({ type: "flow", phase: "succeeded", name: this.flowName, run: this as unknown as FlowRun<unknown, any> });
    } catch (error) {
      this.error = error;
      this.status = error instanceof FlowStoppedError || this.stopRequested ? "stopped" : "failed";
      this.emit({ type: "flow", phase: this.status, name: this.flowName, run: this as unknown as FlowRun<unknown, any>, message: error instanceof Error ? error.message : String(error) });
    } finally {
      this.finishedAt = Date.now();
    }
  }

  emit(event: FlowEvent): void {
    this.options.onEvent?.(event);
    if (!this.options.silent) {
      const suffix = event.message ? `: ${event.message}` : "";
      // Keep the default output intentionally compact; applications can use onEvent for structured logs.
      console.log(`[intentum] ${event.type} ${event.name} ${event.phase}${suffix}`);
    }
  }
}

class InternalStep {
  readonly startedAt = Date.now();
  readonly attempts: AttemptRun[] = [];
  status: RunStatus = "running";
  error: unknown;
  private finishedAt?: number;

  constructor(readonly name: string, private readonly run: FlowRun<unknown, any>, private readonly index: number) {}

  get durationMs(): number | undefined { return this.finishedAt === undefined ? undefined : this.finishedAt - this.startedAt; }

  beginAttempt(index: number): AttemptRun {
    const attempt: MutableAttempt = { index, startedAt: Date.now(), status: "running" };
    this.attempts.push(attempt);
    this.run.updateStep(this.index, this.snapshot());
    this.run.emit({ type: "attempt", phase: "started", name: this.name, run: this.run, attempt: attemptSnapshot(attempt) });
    return attempt;
  }

  succeed(attempt?: MutableAttempt): void {
    if (attempt) finishAttempt(attempt, "succeeded");
    this.status = "succeeded";
    this.finishedAt = Date.now();
    this.run.updateStep(this.index, this.snapshot());
    this.run.emit({ type: "step", phase: "succeeded", name: this.name, run: this.run, step: this.snapshot() });
  }

  fail(error: unknown, attempt?: MutableAttempt): void {
    if (attempt) { attempt.error = error; finishAttempt(attempt, "failed"); }
    this.error = error;
    this.status = "failed";
    this.finishedAt = Date.now();
    this.run.updateStep(this.index, this.snapshot());
    this.run.emit({ type: "step", phase: "failed", name: this.name, run: this.run, step: this.snapshot(), message: error instanceof Error ? error.message : String(error) });
  }

  snapshot(): StepRun {
    return {
      name: this.name,
      startedAt: this.startedAt,
      status: this.status,
      attempts: this.attempts.map(attemptSnapshot),
      ...(this.finishedAt === undefined ? {} : { durationMs: this.durationMs }),
      ...(this.error === undefined ? {} : { error: this.error })
    };
  }
}

interface MutableAttempt {
  readonly index: number;
  readonly startedAt: number;
  durationMs?: number;
  status: AttemptRun["status"];
  error?: unknown;
}

function finishAttempt(attempt: MutableAttempt, status: AttemptRun["status"]): void {
  attempt.status = status;
  attempt.durationMs = Date.now() - attempt.startedAt;
}

function attemptSnapshot(attempt: AttemptRun | MutableAttempt): AttemptRun {
  return {
    index: attempt.index,
    startedAt: attempt.startedAt,
    status: attempt.status,
    ...(attempt.durationMs === undefined ? {} : { durationMs: attempt.durationMs }),
    ...(attempt.error === undefined ? {} : { error: attempt.error })
  };
}

export interface IntentumFlow<Args extends readonly unknown[], Result> {
  (...args: Args): FlowRun<Result, Args>;
  start(...args: Args): FlowRun<Result, Args>;
  readonly name: string;
}

/** Make an ordinary sync or async function observable and inspectable. */
export function flow<Args extends readonly unknown[], Result>(
  functionValue: (...args: Args) => Awaitable<Result>,
  options: FlowOptions = {}
): IntentumFlow<Args, Result> {
  const name = options.name ?? (functionValue.name || "anonymous");
  const invoke = (...args: Args): FlowRun<Result, Args> => new FlowRun(functionValue, args, name, options);
  const wrapped = invoke as IntentumFlow<Args, Result>;
  wrapped.start = invoke;
  Object.defineProperty(wrapped, "name", { value: name });
  return wrapped;
}

export function step<T>(operation: () => T | PromiseLike<T>, options: { readonly name?: string } = {}): T | Promise<T> {
  const run = activeRun.getStore();
  if (!run) throw new Error("step() can only be used inside an active flow");
  const stepRun = run.beginStep(options.name ?? "step");
  if (run.isStopRequested()) {
    stepRun.fail(new FlowStoppedError());
    throw new FlowStoppedError();
  }
  try {
    const result = operation();
    if (isPromiseLike(result)) {
      return Promise.resolve(result).then((value) => {
        stepRun.succeed();
        return value;
      }, (error: unknown) => {
        stepRun.fail(error);
        throw error;
      });
    }
    stepRun.succeed();
    return result;
  } catch (error) {
    stepRun.fail(error);
    throw error;
  }
}

export async function retry<T>(
  policy: RetryPolicy,
  operation: () => Awaitable<T>,
  options: { readonly name?: string } = {}
): Promise<T> {
  const run = activeRun.getStore();
  if (!run) throw new Error("retry() can only be used inside an active flow");
  const stepRun = run.beginStep(options.name ?? "retry");
  const attempts = Math.max(1, Math.floor(policy.attempts));
  let delay = Math.max(0, policy.delayMs ?? 0);
  let lastError: unknown;
  for (let index = 1; index <= attempts; index += 1) {
    if (run.isStopRequested()) {
      const stopped = new FlowStoppedError();
      stepRun.fail(stopped);
      throw stopped;
    }
    const attempt = stepRun.beginAttempt(index);
    try {
      const value = await operation();
      stepRun.succeed(attempt as MutableAttempt);
      return value;
    } catch (error) {
      lastError = error;
      (attempt as MutableAttempt).error = error;
      finishAttempt(attempt as MutableAttempt, "failed");
      if (index < attempts) {
        run.emit({ type: "attempt", phase: "retrying", name: stepRun.name, run, attempt: attemptSnapshot(attempt as MutableAttempt), message: error instanceof Error ? error.message : String(error) });
        if (delay > 0) await sleep(delay, run);
        delay *= policy.backoff ?? 1;
      }
    }
  }
  stepRun.fail(lastError);
  throw lastError;
}

function isPromiseLike<T>(value: T | PromiseLike<T>): value is PromiseLike<T> {
  return typeof value === "object" && value !== null && "then" in value && typeof value.then === "function";
}

async function sleep(delayMs: number, run: FlowRun<unknown, any>): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
  if (run.isStopRequested()) throw new FlowStoppedError();
}

export function getActiveFlow(): FlowRun<unknown, any> | undefined { return activeRun.getStore(); }
