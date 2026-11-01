import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { always, assess, changes, state, THRESHOLD } from "./review-risk.mjs";

const file = (path: string) => ({ path, additions: 1, deletions: 0 });
const pullRequest = (...paths: string[]) => ({ title: "Landing page", body: "Copy", files: paths.map(file), diff: "diff --git a/x b/x\n+copy\n" });
const never = async () => {
  throw new Error("asked the model");
};

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("review risk", () => {
  it("calls CI, the merge gate, migrations and sign-in high without asking the model", async () => {
    for (const path of [
      ".github/workflows/ci.yml",
      ".github/scripts/review-risk.mjs",
      ".claude/skills/pr-watch/pr-digest.mjs",
      "packages/db/prisma/migrations/1_x/migration.sql",
      "apps/web/src/lib/auth.ts",
      "apps/web/src/server/api-keys.ts",
    ]) {
      expect(always([file(path)])).toBeTruthy();
      expect((await assess(pullRequest("apps/web/src/app/page.tsx", path), never)).risk).toBe("high");
    }
    expect(always([file("apps/web/src/app/page.tsx"), file("docs/plan.md")])).toBeUndefined();
  });

  it("sees both paths of a renamed file", () => {
    const root = mkdtempSync(join(tmpdir(), "review-risk-"));
    try {
      const git = (...args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
      git("init", "-q");
      git("config", "user.name", "Test");
      git("config", "user.email", "e2e-review-risk@example.com");
      git("config", "commit.gpgsign", "false");
      const path = join(root, "apps/web/src/server/session.ts");
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, "export const session = 1;\n");
      git("add", ".");
      git("commit", "-qm", "base");
      git("mv", "apps/web/src/server/session.ts", "apps/web/src/server/sessions.ts");
      git("commit", "-qm", "rename");
      const { files } = changes("HEAD~1", "HEAD", root);
      expect(files.map((f) => f.path).sort()).toEqual(["apps/web/src/server/session.ts", "apps/web/src/server/sessions.ts"]);
      expect(always(files)).toBeTruthy();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
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

  it("is high when the model's answer isn't a probability", async () => {
    vi.stubEnv("OPENROUTER_API_KEY", "test-key");
    for (const noul of [-0.3, 1.2, "0.2"]) {
      vi.stubGlobal("fetch", async () => Response.json({ answers: { review: { type: "noul", noul } } }));
      expect((await assess(pullRequest("apps/web/src/app/page.tsx"))).risk).toBe("high");
    }
    vi.stubGlobal("fetch", async () => Response.json({ answers: { review: { type: "noul", noul: 0.2 } } }));
    expect((await assess(pullRequest("apps/web/src/app/page.tsx"))).risk).toBe("low");
  });

  it("lists every file but cuts the diff to what the model reads well", () => {
    const big = (name: string) => `diff --git a/${name} b/${name}\n${"+".repeat(10_000)}\n`;
    const read = state({ ...pullRequest("a", "b", "c", "d", "e"), diff: ["a", "b", "c", "d", "e"].map(big).join("") });
    expect(read.files).toHaveLength(5);
    expect(read.diff).toHaveLength(20_000);
    // Each file gets its share: the second starts after the first's 6,000 characters.
    expect(read.diff.indexOf("diff --git a/b")).toBe(6_000);
    expect(read.partlyRead).toEqual(["a", "b", "c", "d", "e"]);
  });

  const big = (path: string) => `diff --git a/${path} b/${path}\n${"+".repeat(30_000)}\n`;

  it("reads code before tests and docs", () => {
    const read = state({ ...pullRequest("e2e/a.spec.ts", "apps/web/src/app/page.tsx"), diff: big("e2e/a.spec.ts") + big("apps/web/src/app/page.tsx") });
    expect(read.diff.startsWith("diff --git a/apps/web/src/app/page.tsx")).toBe(true);
  });

  it("is high without asking when server code doesn't all fit, but not for a big page", async () => {
    const server = "apps/web/src/server/posts.ts";
    expect(await assess({ ...pullRequest(server), diff: big(server) }, never)).toEqual({
      risk: "high",
      reason: `more server code than the model reads at once (${server})`,
    });
    const page = "apps/web/src/app/(marketing)/page.tsx";
    expect((await assess({ ...pullRequest(page), diff: big(page) }, async () => 0.2)).risk).toBe("low");
  });
});
