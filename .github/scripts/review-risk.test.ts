import { describe, expect, it } from "vitest";
import { always, assess, state, THRESHOLD } from "./review-risk.mjs";

const file = (path: string) => ({ path, additions: 1, deletions: 0 });
const pullRequest = (...paths: string[]) => ({ title: "Landing page", body: "Copy", files: paths.map(file), diff: "diff --git a/x b/x\n+copy\n" });
const never = async () => {
  throw new Error("asked the model");
};

describe("review risk", () => {
  it("calls workflows, migrations and sign-in high without asking the model", async () => {
    for (const path of [".github/workflows/ci.yml", "packages/db/prisma/migrations/1_x/migration.sql", "apps/web/src/lib/auth.ts", "apps/web/src/server/api-keys.ts"]) {
      expect(always([file(path)])).toBeTruthy();
      expect((await assess(pullRequest("apps/web/src/app/page.tsx", path), never)).risk).toBe("high");
    }
    expect(always([file("apps/web/src/app/page.tsx"), file(".github/scripts/review-risk.mjs")])).toBeUndefined();
  });

  it("is high from the threshold up", async () => {
    expect((await assess(pullRequest("apps/web/src/app/page.tsx"), async () => THRESHOLD - 0.01)).risk).toBe("low");
    expect((await assess(pullRequest("apps/web/src/app/page.tsx"), async () => THRESHOLD)).risk).toBe("high");
  });

  it("is high when the model can't judge", async () => {
    const result = await assess(pullRequest("apps/web/src/app/page.tsx"), async () => {
      throw new Error("402 out of credits");
    });
    expect(result).toEqual({ risk: "high", reason: "the model couldn't judge it: 402 out of credits" });
  });

  it("lists every file but cuts the diff to what the model reads well", () => {
    const big = (name: string) => `diff --git a/${name} b/${name}\n${"+".repeat(10_000)}\n`;
    const read = state({ ...pullRequest("a", "b", "c", "d", "e"), diff: ["a", "b", "c", "d", "e"].map(big).join("") });
    expect(read.files).toHaveLength(5);
    expect(read.diff).toHaveLength(20_000);
    // Each file gets its share: the second starts after the first's 6,000 characters.
    expect(read.diff.indexOf("diff --git a/b")).toBe(6_000);
  });
});
