import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  resolve: {
    alias: {
      "@kairos/engine": path.resolve(__dirname, "packages/engine"),
      "@": path.resolve(__dirname, "apps/local"),
    },
  },
  test: {
    include: ["tests/**/*.test.ts"],
  },
});
