import { prisma } from "@tuti/db";
import { type GithubRepo, syncRepositories } from "@tuti/jobs";
import { log } from "@tuti/shared";
import { z } from "zod";

import { type GithubAccount, githubConfig, installationForUser, installationsForUser, verifyValue } from "@/lib/github";
import { appUrl } from "@/lib/hosts";

import { teamMemberId } from "./conversations";
import { defineOperation, OperationError } from "./define";

/**
 * Connecting GitHub (the app's /api/github routes): owners and admins only, as Settings → Integrations. The routes keep
 * their guards against other sites (the same-site check, the signed state and cookies); who may is the router's.
 */

/** What the connect routes need: the project, who's connecting, and the installation it's on now (null: none). */
export const getGithubConnect = defineOperation({
  name: "githubConnect.get",
  title: "Start connecting GitHub",
  summary: "The project and installation connecting GitHub starts from: owners and admins.",
  method: "GET",
  internal: true,
  scope: "read",
  access: "admin",
  input: z.object({}),
  output: z.object({ projectId: z.string(), userId: z.string(), installationId: z.number().nullable() }),
  run: async ({ actor, projectId }) => {
    const installation = await prisma.githubInstallation.findUnique({ where: { projectId }, select: { installationId: true } });
    return { projectId, userId: teamMemberId(actor), installationId: installation?.installationId ?? null };
  },
});

const account = z.object({ id: z.number(), login: z.string(), type: z.string() });
const RESULTS = ["connected", "unconfirmed", "install", "choose", "expired"] as const;
type Result = (typeof RESULTS)[number];

/**
 * The callback's work, once GitHub's web authorization flow comes back with `code` and our signed `state`: only for
 * the project the state names, finished by whoever started it (another admin sent someone else's link would make the
 * list theirs), and connected only if GitHub says the person who authorized can see the installation, so nobody can
 * claim another's. "choose": the accounts they have the App on, to pick from (none: on to install it). "expired": a
 * state that isn't ours, is out of date, or isn't this project's or this person's; nothing done.
 */
export const finishGithubConnect = defineOperation({
  name: "githubConnect.finish",
  title: "Finish connecting GitHub",
  summary: "Connect the installation GitHub's authorization confirmed, or list the accounts to pick from: owners and admins.",
  method: "POST",
  internal: true,
  scope: "write",
  access: "admin",
  errors: [503],
  input: z.object({ state: z.string().max(2000), code: z.string().max(500).optional() }),
  output: z.object({
    /** The project's id, which the accounts to pick from are signed for (server/github-connect.ts: accountsFromCookie). */
    projectId: z.string(),
    result: z.enum(RESULTS),
    /** For "choose": whether the project is connected already (Switch account: the choice is on the GitHub page). */
    switching: z.boolean(),
    accounts: z.array(account),
  }),
  run: async ({ actor, projectId }, { state, code }) => {
    const answer = (result: Result, accounts: z.infer<typeof account>[] = [], switching = false) => ({ projectId, result, switching, accounts });
    // Not ours, out of date, for another project or started by someone else: nothing done, to start again.
    const [slug, installation, purpose, startedBy] = verifyValue("callback", state) ?? [];
    const project = await prisma.project.findUniqueOrThrow({ where: { id: projectId }, select: { slug: true } });
    if (slug !== project.slug || startedBy !== teamMemberId(actor)) {
      return answer("expired");
    }
    const config = githubConfig();
    if (!config) {
      throw new OperationError(503, "not_configured", "GitHub isn't set up on this server");
    }
    const redirectUri = new URL("/api/github/callback", appUrl()).href;
    if (purpose === "choose") {
      const installations = code ? await installationsForUser(config, code, redirectUri).catch(() => null) : null;
      if (!installations) {
        return answer("unconfirmed");
      }
      if (installations.length === 0) {
        return answer("install");
      }
      const switching = (await prisma.githubInstallation.count({ where: { projectId } })) > 0;
      return answer(
        "choose",
        installations.slice(0, 50).map((i) => ({ id: i.id, login: i.account.login, type: i.account.type })),
        switching,
      );
    }
    const installationId = Number(installation);
    const found = code && (await installationForUser(config, code, redirectUri, installationId).catch(() => null));
    if (!found) {
      return answer("unconfirmed");
    }
    await saveConnection({ id: projectId, userId: teamMemberId(actor) }, installationId, found.account, found.repositories);
    return answer("connected");
  },
});

/**
 * Connects the project to the installation (again, to list repositories given access since). Its
 * list is the installation's repositories the person who connected can access on GitHub
 * (`accessible`), and those the project already has; a project starts with none of them, for the
 * team to add. Seeing an installation takes access to only one of its repositories, so the list
 * mustn't be what the App can see.
 */
async function saveConnection(project: { id: string; userId: string }, installationId: number, account: GithubAccount, accessible: GithubRepo[]) {
  const connection = await prisma.$transaction(async (tx) => {
    const existing = await tx.githubInstallation.findUnique({ where: { projectId: project.id }, select: { id: true, installationId: true } });
    const switched = existing !== null && existing.installationId !== installationId;
    if (switched) {
      // Connected to another account before: its repositories go, and so does its list.
      await tx.githubRepository.deleteMany({ where: { connectionId: existing.id } });
    }
    // The project's repositories stay listed, even if this person can't access them: someone who could added them.
    const included = existing && !switched ? await tx.githubRepository.findMany({ where: { connectionId: existing.id }, select: { repoId: true, fullName: true } }) : [];
    const ids = new Set(accessible.map((repo) => repo.id));
    const repositories = [...accessible, ...included.filter((repo) => !ids.has(repo.repoId)).map((repo) => ({ id: repo.repoId, fullName: repo.fullName }))];
    const data = { installationId, accountLogin: account.login, accountType: account.type, repositories };
    return tx.githubInstallation.upsert({
      where: { projectId: project.id },
      update: data,
      create: { ...data, projectId: project.id, createdById: project.userId },
      select: { id: true },
    });
  });
  // Best effort (drops what the App can't see any more): connected either way, and Refresh list tries again.
  await syncRepositories(connection.id, installationId).catch((error: unknown) =>
    log.warn("Couldn't list a GitHub installation's repositories", { error, installationId }),
  );
}
