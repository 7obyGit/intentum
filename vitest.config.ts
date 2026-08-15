import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    environment: "node",
    coverage: {
      include: ["src/**/*.ts"],
      exclude: ["src/index.ts"],
      reporter: ["text", "json-summary"],
      thresholds: {
        statements: 85,
        branches: 70,
        functions: 90,
        lines: 85
      }
    }
  }
});
