/** The most one "Add changes" adds (in batches of changelog.addPullRequests' own limit): more than a busy release has. */
export const MAX_PICKED_PULL_REQUESTS = 500;

/**
 * The missing pull requests that start unticked in "Add changes": the ones Autopilot found nothing for users in, and
 * any past the most one add takes (counting only the ticked ones, newest first as listed), so the default always goes
 * through. By their `repo#number`.
 */
export function untickedByDefault(pullRequests: { repo: string; number: number; forUsers: boolean | null }[], max = MAX_PICKED_PULL_REQUESTS): Set<string> {
  let ticked = 0;
  return new Set(pullRequests.filter((pr) => pr.forUsers === false || ++ticked > max).map((pr) => `${pr.repo}#${pr.number}`));
}
