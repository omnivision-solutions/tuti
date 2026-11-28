import { globSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const sources = ["apps/*/src/**/*.test.ts", "packages/*/src/**/*.test.ts"];
const dbTests = sources.map((pattern) => pattern.replace(".test.ts", ".db.test.ts"));
const liveTests = sources.map((pattern) => pattern.replace(".test.ts", ".live.test.ts"));
const unitTests = [...sources, "vitest.setup.test.ts", ".claude/skills/*/*.test.ts", ".github/scripts/*.test.ts", "infra/*/*.test.ts"];
// Unit files share workers (isolate: false), which cuts the unit tests' time by about a third; a file that mocks a module gets a worker
// of its own, or its mocks would stand in for the real module in the files after it.
const mockingTests = globSync(unitTests, { exclude: [...dbTests, ...liveTests] }).filter((file) => /\bvi\s*\.\s*(mock|doMock)\b/.test(readFileSync(file, "utf8")));
const unit = { setupFiles: ["./vitest.setup.ts", "./apps/web/src/test/next-intl-english.ts"] };

export default defineConfig({
  resolve: {
    alias: {
      "@/": fileURLToPath(new URL("./apps/web/src/", import.meta.url)),
      // Next.js compiles next/font when the app is built: tests get a stand-in (see the file).
      "next/font/local": fileURLToPath(new URL("./apps/web/src/test/next-font-local.ts", import.meta.url)),
    },
  },
  test: {
    projects: [
      {
        extends: true,
        test: {
          name: "unit",
          isolate: false,
          include: unitTests,
          exclude: [...dbTests, ...liveTests, ...mockingTests],
          ...unit,
        },
      },
      {
        extends: true,
        test: { name: "unit-mocks", include: mockingTests, ...unit },
      },
      {
        extends: true,
        test: {
          name: "db",
          include: dbTests,
          globalSetup: ["./vitest.db-global.ts"],
          setupFiles: ["./vitest.setup.ts", "./vitest.db-setup.ts", "./apps/web/src/test/setup.ts", "./apps/web/src/test/next-intl-english.ts"],
        },
      },
      {
        // Real services (`pnpm test:live`): run by hand with real keys; without them, skipped.
        extends: true,
        test: { name: "live", include: liveTests },
      },
    ],
  },
});
