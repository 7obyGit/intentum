import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CodexProvider } from "../src/provider.js";
import { objectSchema, stringSchema } from "../src/schema.js";

describe("Codex provider", () => {
  it("passes --output-schema and reads the final output file", async () => {
    const directory = await mkdtemp(join(tmpdir(), "intentum-test-"));
    const command = join(directory, "codex-mock.mjs");
    await writeFile(command, `#!/usr/bin/env node
const args = process.argv.slice(2);
const output = args[args.indexOf('--output-last-message') + 1];
if (args.includes('--output-schema') && output) await import('node:fs/promises').then((fs) => fs.writeFile(output, JSON.stringify({ answer: 'ok' })));
console.log(JSON.stringify({ type: 'thread.started', thread_id: 'test-thread' }));
console.log(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: '{\\"answer\\":\\"ok\\"}' } }));`, "utf8");
    await chmod(command, 0o755);
    try {
      const schema = objectSchema("Answer", { answer: stringSchema() });
      const provider = new CodexProvider({ command, sandbox: "read-only" });
      await expect(provider.generateStructured({ prompt: "answer", schema })).resolves.toEqual({ answer: "ok" });
      const result = await provider.runTask("report");
      expect(result.threadId).toBe("test-thread");
      expect(result.events).toHaveLength(2);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
