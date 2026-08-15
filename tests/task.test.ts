import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { CodexProvider, CodexTaskResult } from "../src/provider.js";
import { runTask, task } from "../src/task.js";

describe("tasks", () => {
  it("builds instructions from original and safely displayed arguments", async () => {
    let receivedInstruction = "";
    let receivedImages: readonly { data: string; mimeType?: string }[] = [];
    const result: CodexTaskResult = {
      output: "done",
      events: [{ type: "item.completed" }],
      returncode: 0,
      threadId: "thread"
    };
    const fakeCodex = {
      runTask: async (instruction: string, _signal?: AbortSignal, images?: readonly { data: string; mimeType?: string }[]) => {
        receivedInstruction = instruction;
        receivedImages = images ?? [];
        return result;
      }
    } as unknown as CodexProvider;
    const audit = task<[string]>({
      name: "audit",
      codex: fakeCodex,
      instruction: (args, displayArgs) => {
        expect(args).toEqual(["data:image/png;base64,QUJD"]);
        expect(displayArgs).toEqual(["<image data>"]);
        return `Audit ${displayArgs[0]}`;
      },
      images: async () => [{ data: "REVG", mimeType: "image/jpeg" }]
    });
    await expect(audit("data:image/png;base64,QUJD")).resolves.toBe(result);
    expect(receivedInstruction).toBe("Audit <image data>");
    expect(receivedImages).toEqual([
      { data: "QUJD", mimeType: "image/png" },
      { data: "REVG", mimeType: "image/jpeg" }
    ]);
  });

  it("passes ordinary arguments through without inventing images", async () => {
    let received: { instruction: string; images: readonly unknown[] | undefined } | undefined;
    const fakeCodex = {
      runTask: async (instruction: string, _signal?: AbortSignal, images?: readonly unknown[]) => {
        received = { instruction, images };
        return { output: "ok", events: [], returncode: 0 } satisfies CodexTaskResult;
      }
    } as unknown as CodexProvider;
    const run = task<[string]>({
      codex: fakeCodex,
      instruction: ([value], display) => `${value}:${display[0]}`
    });
    await expect(run("plain text")).resolves.toMatchObject({ output: "ok" });
    expect(received).toEqual({ instruction: "plain text:plain text", images: [] });
  });

  it("runs the direct task helper with Codex options", async () => {
    const directory = await mkdtemp(join(tmpdir(), "intentum-task-test-"));
    const command = join(directory, "codex.mjs");
    await writeFile(command, "#!/usr/bin/env node\nconsole.log(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'direct result' } }));\n", "utf8");
    await chmod(command, 0o755);
    try {
      await expect(runTask("direct instruction", { command, maxRetries: 0 })).resolves.toMatchObject({ output: "direct result", returncode: 0 });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
