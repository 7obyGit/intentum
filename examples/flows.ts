import { flow, retry, step } from "intentum";

let calls = 0;
const research = flow(async (topic: string) => {
  const normalized = step(() => topic.trim(), { name: "normalize" });
  const findings = await retry(
    { attempts: 3, delayMs: 5 },
    async () => {
      calls += 1;
      if (calls < 2) throw new Error("temporary source failure");
      return `Findings for ${normalized}`;
    },
    { name: "research" }
  );
  return findings;
}, {
  silent: false,
  onEvent: (event) => console.debug(event.type, event.name, event.phase)
});

const run = research(" typed workflows ");
console.log(await run.result());
console.log(run.status, run.steps);
