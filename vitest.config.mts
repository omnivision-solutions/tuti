import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const sources = ["apps/*/src/**/*.test.ts", "packages/*/src/**/*.test.ts"];
const dbTests = sources.map((pattern) => pattern.replace(".test.ts", ".db.test.ts"));

export default defineConfig({
  resolve: {
    alias: {
      "@/": fileURLToPath(new URL("./apps/web/src/", import.meta.url)),
      // Next.js compiles next/font when the app is built: tests get a stand-in (see the file).
      "next/font/google": fileURLToPath(new URL("./apps/web/src/test/next-font-google.ts", import.meta.url)),
    },
  },
  test: {
    projects: [
      {
        extends: true,
        test: {
          name: "unit",
          include: [...sources, "vitest.setup.test.ts"],
          exclude: dbTests,
          setupFiles: ["./vitest.setup.ts"],
        },
      },
      {
        extends: true,
        test: {
          name: "db",
          include: dbTests,
          globalSetup: ["./vitest.db-global.ts"],
          setupFiles: ["./vitest.setup.ts", "./vitest.db-setup.ts", "./apps/web/src/test/setup.ts"],
        },
      },
    ],
  },
});
