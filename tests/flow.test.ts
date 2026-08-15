import { describe, expect, it } from "vitest";
import { FlowStoppedError, flow, getActiveFlow, retry, step } from "../src/flow.js";

describe("flows", () => {
  it("records typed steps and succeeds", async () => {
    const events: string[] = [];
    const pipeline = flow(async (input: string) => {
      const cleaned = step(() => input.trim(), { name: "clean" });
      return step(async () => `${cleaned}!`, { name: "decorate" });
    }, { silent: true, onEvent: (event) => events.push(`${event.type}:${event.phase}`) });
    const run = pipeline(" Ada ");
    await expect(run.result()).resolves.toBe("Ada!");
    expect(run.status).toBe("succeeded");
    expect(run.steps.map((entry) => entry.name)).toEqual(["clean", "decorate"]);
    expect(events).toContain("flow:succeeded");
  });

  it("retries failed operations and records attempts", async () => {
    let calls = 0;
    const pipeline = flow(async () => retry({ attempts: 3 }, async () => {
      calls += 1;
      if (calls < 3) throw new Error("temporary");
      return "done";
    }, { name: "remote" }), { silent: true });
    const run = pipeline();
    await expect(run.result()).resolves.toBe("done");
    expect(run.steps[0]?.attempts).toHaveLength(3);
  });

  it("captures failures and permits a whole-run retry", async () => {
    let calls = 0;
    const pipeline = flow(() => {
      calls += 1;
      if (calls === 1) throw new Error("first run");
      return "recovered";
    }, { silent: true });
    const run = pipeline();
    await expect(run.result()).rejects.toThrow("first run");
    expect(run.status).toBe("failed");
    await expect(run.retry().result()).resolves.toBe("recovered");
  });

  it("exposes the active run and supports start, promise, and wait aliases", async () => {
    let active: unknown;
    const pipeline = flow(async () => {
      active = getActiveFlow();
      return step(async () => "done", { name: "async-step" });
    }, { name: "named-pipeline", silent: true });

    expect(pipeline.name).toBe("named-pipeline");
    const run = pipeline.start();
    expect(active).toBe(run);
    await expect(run.promise).resolves.toBe("done");
    await expect(run.wait()).resolves.toBe("done");
    expect(run.durationMs).toBeGreaterThanOrEqual(0);
    expect(run.steps[0]).toMatchObject({ name: "async-step", status: "succeeded" });
  });

  it("rejects step and retry calls outside an active flow", async () => {
    expect(() => step(() => "nope")).toThrow("active flow");
    await expect(retry({ attempts: 1 }, async () => "nope")).rejects.toThrow("active flow");
  });

  it("records synchronous and asynchronous step failures with error metadata", async () => {
    const syncRun = flow(() => step(() => { throw new Error("sync failure"); }, { name: "sync" }), { silent: true })();
    await expect(syncRun.result()).rejects.toThrow("sync failure");
    expect(syncRun.steps[0]).toMatchObject({ name: "sync", status: "failed" });
    expect(syncRun.steps[0]?.error).toBeInstanceOf(Error);

    const asyncRun = flow(async () => step(async () => { throw new Error("async failure"); }, { name: "async" }), { silent: true })();
    await expect(asyncRun.result()).rejects.toThrow("async failure");
    expect(asyncRun.steps[0]).toMatchObject({ name: "async", status: "failed" });
    expect(asyncRun.steps[0]?.attempts).toEqual([]);
  });

  it("emits the full flow, step, and retry event lifecycle", async () => {
    let calls = 0;
    const events: string[] = [];
    const pipeline = flow(async () => {
      step(() => "ready", { name: "prepare" });
      return retry({ attempts: 2 }, () => {
        calls += 1;
        if (calls === 1) throw new Error("try again");
        return "ok";
      }, { name: "remote" });
    }, { name: "pipeline", silent: true, onEvent: (event) => events.push(`${event.type}:${event.name}:${event.phase}`) });

    await expect(pipeline().result()).resolves.toBe("ok");
    expect(events).toEqual([
      "flow:pipeline:started",
      "step:prepare:started",
      "step:prepare:succeeded",
      "step:remote:started",
      "attempt:remote:started",
      "attempt:remote:retrying",
      "attempt:remote:started",
      "step:remote:succeeded",
      "flow:pipeline:succeeded"
    ]);
  });

  it("clamps invalid retry counts and preserves the final error", async () => {
    const run = flow(() => retry({ attempts: 0 }, () => { throw new Error("permanent"); }, { name: "single" }), { silent: true })();
    await expect(run.result()).rejects.toThrow("permanent");
    expect(run.steps[0]?.attempts).toHaveLength(1);
    expect(run.steps[0]?.attempts[0]).toMatchObject({ index: 1, status: "failed" });
    expect(run.steps[0]?.error).toBeInstanceOf(Error);
  });

  it("stops an in-flight flow and rejects repeated or terminal stops", async () => {
    let resolveOperation!: () => void;
    const pending = new Promise<void>((resolve) => { resolveOperation = resolve; });
    const run = flow(async () => step(() => pending, { name: "pending" }), { silent: true })();

    expect(run.stop()).toBe(true);
    expect(run.stop()).toBe(true);
    resolveOperation();
    await expect(run.result()).rejects.toBeInstanceOf(FlowStoppedError);
    expect(run.status).toBe("stopped");
    expect(run.stop()).toBe(false);
    await expect(run.retry().result()).resolves.toBeUndefined();
  });

  it("allows retrying a stopped run and reports invalid retry attempts", async () => {
    const run = flow(async () => {
      await new Promise<void>((resolve) => setTimeout(resolve, 5));
      return "done";
    }, { silent: true })();
    expect(() => run.retry()).toThrow("failed or stopped");
    run.stop();
    await expect(run.result()).rejects.toBeInstanceOf(FlowStoppedError);
    await expect(run.retry().result()).resolves.toBe("done");
  });
});
