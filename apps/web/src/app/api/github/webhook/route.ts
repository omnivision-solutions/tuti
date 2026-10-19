import { prisma } from "@tuti/db";
import { enqueue } from "@tuti/jobs";
import { log } from "@tuti/shared";

import { githubConfig, verifyWebhookSignature } from "@/lib/github";

/**
 * The Tuti App's webhook. Only correctly signed deliveries are read; work beyond
 * bookkeeping goes to background jobs so GitHub gets its answer quickly.
 */
export async function POST(request: Request) {
  const config = githubConfig();
  if (!config) {
    return new Response(null, { status: 404 });
  }
  const body = await request.text();
  if (!verifyWebhookSignature(config.webhookSecret, body, request.headers.get("x-hub-signature-256"))) {
    return Response.json({ error: "Bad signature" }, { status: 401 });
  }
  const event = request.headers.get("x-github-event");
  const payload = JSON.parse(body) as { action?: string; installation?: { id: number } };

  // Uninstalled (or suspended) on GitHub: the project is no longer connected.
  if (event === "installation" && (payload.action === "deleted" || payload.action === "suspend") && payload.installation) {
    const { count } = await prisma.githubInstallation.deleteMany({ where: { installationId: payload.installation.id } });
    log.info("GitHub installation removed", { installationId: payload.installation.id, projects: count });
  }
  // Pull requests: linking and status changes (and completing on merge) happen in the github-pull-request job.
  if (event === "pull_request" && PR_ACTIONS.has(payload.action ?? "") && payload.installation) {
    const { pull_request: pr, repository } = payload as unknown as GithubPullRequestEvent;
    try {
      await enqueue("githubPullRequest", {
        installationId: payload.installation.id,
        action: payload.action!,
        repo: repository.full_name,
        number: pr.number,
        title: pr.title,
        body: pr.body ?? "",
        url: pr.html_url,
        merged: pr.merged ?? false,
      });
    } catch (error) {
      log.error("Handling a GitHub pull request failed", { error, repo: repository.full_name, number: pr.number });
      // Not acknowledged, so GitHub shows the delivery as failed and it can be redelivered.
      return Response.json({ error: "Couldn't handle the pull request" }, { status: 503 });
    }
  }
  // Published releases: the github-release job completes the posts they ship.
  if (event === "release" && payload.action === "published" && payload.installation) {
    const { release, repository } = payload as unknown as GithubReleaseEvent;
    try {
      await enqueue("githubRelease", {
        installationId: payload.installation.id,
        repo: repository.full_name,
        tag: release.tag_name,
        name: release.name || release.tag_name,
        url: release.html_url,
        publishedAt: release.published_at ?? new Date().toISOString(),
      });
    } catch (error) {
      log.error("Handling a GitHub release failed", { error, repo: repository.full_name, tag: release.tag_name });
      return Response.json({ error: "Couldn't handle the release" }, { status: 503 });
    }
  }
  return Response.json({ ok: true });
}

type GithubReleaseEvent = {
  release: { tag_name: string; name: string | null; html_url: string; published_at: string | null };
  repository: { full_name: string };
};

const PR_ACTIONS = new Set(["opened", "reopened", "edited", "closed"]);

type GithubPullRequestEvent = {
  pull_request: { number: number; title: string; body: string | null; html_url: string; merged?: boolean };
  repository: { full_name: string };
};
