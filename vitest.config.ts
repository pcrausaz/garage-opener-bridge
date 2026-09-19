import { defineConfig } from "vitest/config";
export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    exclude: ["test/live/**"],
    environment: "node",
    testTimeout: 20000,
    hookTimeout: 20000,
  },
});
