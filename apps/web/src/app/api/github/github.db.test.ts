import { prisma } from "@tuti/db";
import { type GithubFake, startGithubFake } from "@tuti/testkit";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";

import { signInstallState, verifyInstallState } from "@/lib/github";
import { actAs, addMember, createProject, signUp, type TestUser } from "@/test/helpers";

import { GET as setup } from "./setup/route";
import { POST as webhook } from "./webhook/route";

let github: GithubFake;
let owner: TestUser;
let project: Awaited<ReturnType<typeof createProject>>;

beforeAll(async () => {
  github = await startGithubFake();
});
afterAll(() => github.close());
beforeEach(async () => {
  for (const [name, value] of Object.entries(github.env)) {
    vi.stubEnv(name, value);
  }
  owner = await signUp("Olive Owner");
  project = await createProject(owner);
  actAs(owner);
});
afterEach(() => vi.unstubAllEnvs());

/** GitHub sends the browser back here after the install. */
async function returnFromGithub(params: Record<string, string>) {
  const response = await setup(new Request(`http://tuti.localhost:3100/api/github/setup?${new URLSearchParams(params)}`));
  return response.headers.get("location");
}

describe("connecting", () => {
  test("the installer can see the installation: the project is connected", async () => {
    github.user("code-1", [{ id: 501, account: "acme" }]);
    const location = await returnFromGithub({ installation_id: "501", code: "code-1", state: signInstallState(project.id) });
    expect(location).toBe(`http://tuti.localhost:3100/app/${project.slug}/settings?github=connected`);
    expect(await prisma.githubInstallation.findUnique({ where: { projectId: project.id } })).toMatchObject({
      installationId: 501,
      accountLogin: "acme",
    });
  });

  test("someone else's installation can't be claimed", async () => {
    // A real user who can see installation 777, but not 501.
    github.user("code-2", [{ id: 777, account: "mine" }]);
    expect(await returnFromGithub({ installation_id: "501", code: "code-2", state: signInstallState(project.id) })).toMatch(
      /github=unconfirmed$/,
    );
    expect(await returnFromGithub({ installation_id: "501", code: "made-up", state: signInstallState(project.id) })).toMatch(
      /github=unconfirmed$/,
    );
    expect(await returnFromGithub({ installation_id: "501", state: signInstallState(project.id) })).toMatch(/github=unconfirmed$/);
    expect(await prisma.githubInstallation.count({ where: { projectId: project.id } })).toBe(0);
  });

  test("the state must be ours, fresh, and for a project the person administers", async () => {
    github.user("code-3", [{ id: 502, account: "acme" }]);
    const params = { installation_id: "502", code: "code-3" };
    expect(await returnFromGithub({ ...params, state: `${project.id}.9999999999.forged` })).toBe(
      "http://tuti.localhost:3100/app?github=expired",
    );
    expect(await returnFromGithub({ ...params, state: signInstallState(project.id, Date.now() - 60 * 60 * 1000) })).toMatch(
      /\/app\?github=expired$/,
    );
    actAs(await addMember(project.id, "MEMBER"));
    expect(await returnFromGithub({ ...params, state: signInstallState(project.id) })).toMatch(/\/app\?github=expired$/);
    actAs(null);
    expect(await returnFromGithub({ ...params, state: signInstallState(project.id) })).toMatch(/\/sign-in\?next=/);
    expect(await prisma.githubInstallation.count({ where: { projectId: project.id } })).toBe(0);
  });

  test("an installation connected to one project can't be connected to another", async () => {
    github.user("code-4", [{ id: 503, account: "acme" }]);
    await returnFromGithub({ installation_id: "503", code: "code-4", state: signInstallState(project.id) });
    const other = await createProject(owner);
    expect(await returnFromGithub({ installation_id: "503", code: "code-4", state: signInstallState(other.id) })).toMatch(
      /github=taken$/,
    );
  });

  test("states are tamper-proof", () => {
    const state = signInstallState("project-1");
    expect(verifyInstallState(state)).toBe("project-1");
    expect(verifyInstallState(state.replace("project-1", "project-2"))).toBeNull();
    expect(verifyInstallState("nonsense")).toBeNull();
  });
});

describe("webhook", () => {
  const deliver = async ({ body, headers }: { body: string; headers: Record<string, string> }) =>
    (await webhook(new Request("http://tuti.localhost:3100/api/github/webhook", { method: "POST", body, headers }))).status;

  test("only signed deliveries are read; uninstalling disconnects the project", async () => {
    await prisma.githubInstallation.create({
      data: { projectId: project.id, installationId: 600, accountLogin: "acme", createdById: owner.id },
    });
    const uninstall = github.webhook("installation", { action: "deleted", installation: { id: 600 } });

    expect(await deliver({ ...uninstall, headers: { ...uninstall.headers, "x-hub-signature-256": `sha256=${"0".repeat(64)}` } })).toBe(401);
    expect(await deliver({ body: uninstall.body, headers: { "x-github-event": "installation" } })).toBe(401);
    expect(await prisma.githubInstallation.count({ where: { projectId: project.id } })).toBe(1);

    expect(await deliver(github.webhook("ping", { zen: "Keep it simple." }))).toBe(200);
    expect(await deliver(uninstall)).toBe(200);
    expect(await prisma.githubInstallation.count({ where: { projectId: project.id } })).toBe(0);
  });

  test("without the App configured, the endpoints don't exist", async () => {
    vi.stubEnv("GITHUB_WEBHOOK_SECRET", "");
    expect(await deliver(github.webhook("ping", {}))).toBe(404);
    expect((await setup(new Request("http://tuti.localhost:3100/api/github/setup"))).status).toBe(404);
  });
});
