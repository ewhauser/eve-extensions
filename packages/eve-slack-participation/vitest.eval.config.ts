import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/eval/**/*.eval.ts"],
    exclude: ["**/node_modules/**"],
    fileParallelism: false,
    testTimeout: 15_000,
  },
});
