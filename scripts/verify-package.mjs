import { spawnSync } from "node:child_process";

const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const result = spawnSync(npm, ["pack", "--dry-run", "--json", "--loglevel=error"], {
  encoding: "utf8",
  stdio: ["ignore", "pipe", "pipe"]
});

if (result.error) throw result.error;
if (result.status !== 0) {
  process.stderr.write(result.stderr);
  process.exit(result.status ?? 1);
}

let report;
try {
  report = JSON.parse(result.stdout);
} catch (error) {
  throw new Error(`npm pack returned invalid JSON: ${error instanceof Error ? error.message : String(error)}\n${result.stdout}`);
}

const files = new Set(report[0]?.files?.map(({ path }) => path) ?? []);
const required = [
  "package.json",
  "README.md",
  "CHANGELOG.md",
  "LICENSE",
  "dist/index.js",
  "dist/index.d.ts",
  "docs/README.md",
  "examples/basic.ts"
];
const missing = required.filter((path) => !files.has(path));
const forbidden = [...files].filter((path) =>
  path.startsWith("src/")
  || path.startsWith("tests/")
  || path.startsWith(".github/")
  || path === ".env"
  || path.endsWith("/.env")
);

if (missing.length > 0 || forbidden.length > 0) {
  const problems = [
    ...(missing.length > 0 ? [`missing required files: ${missing.join(", ")}`] : []),
    ...(forbidden.length > 0 ? [`contains excluded files: ${forbidden.join(", ")}`] : [])
  ];
  throw new Error(`npm package contents are invalid; ${problems.join("; ")}`);
}

console.log(`Package contents verified (${files.size} files).`);
