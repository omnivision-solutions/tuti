import type { GithubRepositoryRow } from "@/components/github-connection";

/**
 * The rows of Settings → Integrations → Repositories, sorted by name: each listed repository,
 * whether this project includes it, and which project does instead. A project on another
 * installation (where the repository was before it moved) doesn't block it: the server asks
 * GitHub where it is now when it's switched on.
 */
export function repositoryRows(
  listed: { id: number; fullName: string }[],
  includedIds: number[],
  holders: { repoId: number; installationId: number; project: string }[],
  installationId: number,
): GithubRepositoryRow[] {
  return listed
    .map((repo) => ({
      ...repo,
      included: includedIds.includes(repo.id),
      elsewhere: holders.find((holder) => holder.repoId === repo.id && holder.installationId === installationId)?.project ?? null,
    }))
    .sort((a, b) => a.fullName.localeCompare(b.fullName));
}
