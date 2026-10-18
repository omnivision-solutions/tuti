import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: { "@/": fileURLToPath(new URL("./apps/web/src/", import.meta.url)) },
  },
  test: {
    include: ["apps/*/src/**/*.test.ts", "packages/*/src/**/*.test.ts", "vitest.setup.test.ts"],
    setupFiles: ["./vitest.setup.ts"],
  },
});
