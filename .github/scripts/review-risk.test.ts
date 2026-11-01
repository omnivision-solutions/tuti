import { afterEach, describe, expect, it, vi } from "vitest";
import { always, assess, fromGitHub, state, THRESHOLD } from "./review-risk.mjs";

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
      "apps/web/src/lib/api-keys.ts",
      "apps/web/src/lib/sso.ts",
      "apps/web/src/server/api-keys.ts",
      "apps/web/src/server/password-reset.ts",
      "apps/web/src/app/portal/[project]/(site)/sso/route.ts",
      "packages/shared/src/signed.ts",
      "packages/email/src/password-reset-email.tsx",
      "AGENTS.md",
      ".coderabbit.yaml",
      "greptile.json",
    ]) {
      expect(always([file(path)])).toBeTruthy();
      expect((await assess(pullRequest("apps/web/src/app/page.tsx", path), never)).risk).toBe("high");
    }
    expect(always([file("apps/web/src/app/page.tsx"), file("docs/plan.md"), file("apps/web/src/server/authorization.db.test.ts")])).toBeUndefined();
  });

  it("reads GitHub's file list: both paths of a rename, any characters, no lockfile diff", () => {
    const { files, diff } = fromGitHub(
      [
        { filename: "apps/web/src/server/sessions.ts", previous_filename: "apps/web/src/server/session.ts", additions: 0, deletions: 0 },
        { filename: ".github/workflows/déploy.yml", additions: 3, deletions: 0 },
        { filename: "pnpm-lock.yaml", additions: 900, deletions: 20 },
      ],
      "diff --git a/pnpm-lock.yaml b/pnpm-lock.yaml\n+lock\ndiff --git a/x.ts b/x.ts\n+code\n",
    );
    expect(files.map((f) => f.path)).toEqual([
      "apps/web/src/server/sessions.ts",
      "apps/web/src/server/session.ts",
      ".github/workflows/déploy.yml",
      "pnpm-lock.yaml",
    ]);
    expect(always(files.slice(0, 2))).toBeTruthy();
    expect(always(files.slice(2, 3))).toBeTruthy();
    expect(diff).toBe("diff --git a/x.ts b/x.ts\n+code\n");
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

  it("reads the path of a file whose name git quotes or that has a space", async () => {
    const diff = `diff --git "a/apps/worker/src/jobs/env\\303\\255o.ts" "b/apps/worker/src/jobs/env\\303\\255o.ts"\n${"+".repeat(30_000)}\n`;
    expect(state({ ...pullRequest("apps/worker/src/jobs/envío.ts"), diff }).partlyRead).toEqual(["apps/worker/src/jobs/env\\303\\255o.ts"]);
    expect((await assess({ ...pullRequest("apps/worker/src/jobs/envío.ts"), diff }, never)).risk).toBe("high");
    const spaced = "diff --git a/apps/web/src/app/my page.tsx b/apps/web/src/app/my page.tsx\n+copy\n";
    expect(state({ ...pullRequest("apps/web/src/app/my page.tsx"), diff: spaced }).diff).toBe(spaced);
  });

  it("reads code before tests and docs", () => {
    const read = state({ ...pullRequest("e2e/a.spec.ts", "apps/web/src/app/page.tsx"), diff: big("e2e/a.spec.ts") + big("apps/web/src/app/page.tsx") });
    expect(read.diff.startsWith("diff --git a/apps/web/src/app/page.tsx")).toBe(true);
  });

  it("is high without asking when code doesn't all fit, or a file's diff is missing, but not for a big page", async () => {
    const route = "apps/web/src/app/mcp/route.ts";
    expect((await assess({ ...pullRequest(route), diff: big(route) }, never)).risk).toBe("high");
    const oneMissing = fromGitHub([{ filename: "a.ts", additions: 1, deletions: 0 }, { filename: "b.ts", additions: 1, deletions: 0 }], "diff --git a/a.ts b/a.ts\n+a\n");
    expect(await assess({ ...pullRequest(), ...oneMissing }, never)).toEqual({ risk: "high", reason: "GitHub's diff leaves out some of its files" });
    const server = "apps/web/src/server/posts.ts";
    expect(await assess({ ...pullRequest(server), diff: big(server) }, never)).toEqual({
      risk: "high",
      reason: `more code than the model reads at once (${server})`,
    });
    for (const page of [
      "apps/web/src/app/portal/[project]/(site)/layout.tsx",
      "apps/web/src/app/(marketing)/invite/[token]/page.tsx",
      "apps/web/src/components/portal-docs.tsx",
    ])
      expect((await assess({ ...pullRequest(page), diff: big(page) }, never)).risk).toBe("high");
    const page = "apps/web/src/app/(marketing)/page.tsx";
    expect((await assess({ ...pullRequest(page), diff: big(page) }, async () => 0.2)).risk).toBe("low");
  });
});
