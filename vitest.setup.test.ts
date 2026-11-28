import { expect, test } from "vitest";

test("tests can't reach real services", () => {
  const leaked = Object.keys(process.env).filter(
    (name) => name === "DATABASE_URL" || name.startsWith("OPENAI_") || name.startsWith("HATCHET_CLIENT_") || name.startsWith("SMTP_") || name.startsWith("MEDIA_") || name.startsWith("GITHUB_") || name.startsWith("OPENROUTER_") || name.startsWith("AI_") || name === "DECISION_MODEL" || name.startsWith("CODE_CHANGES_") || name.startsWith("STRIPE_") || name.startsWith("SES_") || name === "BILLING_CONFIG" || name === "TUTI_CONFIG" || name.startsWith("FEATUREBASE_") || name.startsWith("FERNDESK_") || name.startsWith("CANNY_") || name.startsWith("FRILL_") || name.startsWith("NOLT_") || name.startsWith("EXPO_"),
  );
  expect(leaked).toEqual([]);
});

// Unit files share a worker (isolate: false): what one file changes is undone before the next (vitest.setup.ts).
test("a file's environment, globals, fake timers and spies don't reach the next file in its worker", async () => {
  const { BaseSequencer, startVitest } = await import("vitest/node");
  class ByName extends BaseSequencer {
    override sort = async (files: Parameters<BaseSequencer["sort"]>[0]) => [...files].sort((a, b) => a.moduleId.localeCompare(b.moduleId));
  }
  const vitest = await startVitest("test", [], {
    config: false,
    root: import.meta.dirname,
    include: ["vitest-setup-fixtures/*.fixture.ts"],
    setupFiles: ["./vitest.setup.ts"],
    isolate: false,
    maxWorkers: 1,
    fileParallelism: false,
    sequence: { sequencer: ByName },
    watch: false,
    reporters: [],
  });
  const files = vitest.state.getFiles().map((file) => [file.name, file.result?.state]);
  await vitest.close();
  expect(files).toEqual([
    ["vitest-setup-fixtures/1-leaves.fixture.ts", "pass"],
    ["vitest-setup-fixtures/2-checks.fixture.ts", "pass"],
  ]);
});
