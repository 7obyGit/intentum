import { describe, expect, it } from "vitest";
import { flow, retry } from "../src/flow.js";
import { step } from "../src/flow.js";

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
});
