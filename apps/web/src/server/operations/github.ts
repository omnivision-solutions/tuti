import { prisma } from "@tuti/db";
import { z } from "zod";

import { defineOperation } from "./define";

/** The project's GitHub repositories (docs/plan.md, API reference in Docs, A11), for what reads from them. */

export const listGithubRepositories = defineOperation({
  name: "githubRepositories.list",
  title: "List GitHub repositories",
  summary:
    "List the GitHub repositories the project added (Settings › Integrations › GitHub), by name: each one's `id` (GitHub's, which stays when it's renamed or moved: apiReferences.create's `github.repoId`) and `fullName` (owner/name, as last heard from GitHub). Empty when GitHub isn't connected",
  method: "GET",
  path: "/github/repositories",
  scope: "read",
  access: "team",
  input: z.object({}),
  run: async ({ projectId }) => ({
    repositories: (
      await prisma.githubRepository.findMany({ where: { connection: { projectId } }, orderBy: { fullName: "asc" }, select: { repoId: true, fullName: true } })
    ).map(({ repoId, fullName }) => ({ id: repoId, fullName })),
  }),
});
