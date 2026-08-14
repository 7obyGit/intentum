import { CodexProvider, runTask, objectSchema, stringSchema } from "intentum";

const answerSchema = objectSchema("Answer", { answer: stringSchema() });
const codex = new CodexProvider({ sandbox: "read-only" });

// Requires an authenticated Codex CLI. The schema is passed to --output-schema.
const answer = await codex.generateStructured({
  prompt: "Return a one-sentence description of this package.",
  schema: answerSchema
});
console.log(answer);

const audit = await runTask("Review the repository for obvious documentation gaps.", { sandbox: "read-only" });
console.log(audit.output, audit.events.length);
