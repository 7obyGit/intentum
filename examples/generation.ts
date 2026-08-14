import { impl, MemoryCache, MockProvider, shim } from "intentum";

export const slugify = impl<[string], string>({
  name: "slugify",
  parameters: ["value"],
  description: "Convert text into a lowercase URL slug separated by hyphens.",
  returnType: "string",
  cache: new MemoryCache(),
  provider: new MockProvider({
    text: "return value.trim().toLowerCase().replaceAll(/[^a-z0-9]+/g, \"-\");"
  })
});

export const parseJson = shim({
  name: "parseJson",
  parameters: ["input"],
  fn: (input: string) => JSON.parse(input) as unknown,
  provider: new MockProvider({
    structured: { strategy: "rewrite", body: "return JSON.parse(input.replaceAll(\"'\", '\"'));" }
  })
});

console.log(await slugify("Hello, Intentum!"));
console.log(await parseJson("{'ok':true}"));
