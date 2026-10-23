import { prisma } from "@tuti/db";
import { enqueue, forgetRepositories } from "@tuti/jobs";
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
  // Repositories removed from the installation on GitHub leave their project, once GitHub confirms
  // they're gone (if it can't say, the delivery fails, to be redelivered). Added ones wait for a
  // team to add them to a project.
  if (event === "installation_repositories" && payload.installation) {
    const { repositories_removed: removed = [] } = payload as unknown as GithubRepositoriesEvent;
    const installationId = payload.installation.id;
    try {
      await forgetRepositories(
        installationId,
        removed.map((repo) => repo.id),
      );
    } catch (error) {
      log.error("Handling GitHub repositories failed", { error, installationId });
      return Response.json({ error: "Couldn't handle the repositories" }, { status: 503 });
    }
  }
  // Merged pull requests: the github-pull-request job adds them to the changelog's running draft.
  if (event === "pull_request" && payload.action === "closed" && payload.installation) {
    const { pull_request: pr, repository } = payload as unknown as GithubPullRequestEvent;
    if (!pr.merged) {
      return Response.json({ ok: true });
    }
    try {
      await enqueue("githubPullRequest", {
        installationId: payload.installation.id,
        action: payload.action!,
        repoId: repository.id,
        repo: repository.full_name,
        number: pr.number,
        title: pr.title,
        body: pr.body ?? "",
        url: pr.html_url,
        merged: pr.merged ?? false,
        labels: (pr.labels ?? []).map((label) => label.name),
      });
    } catch (error) {
      log.error("Handling a GitHub pull request failed", { error, repo: repository.full_name, number: pr.number });
      // Not acknowledged, so GitHub shows the delivery as failed and it can be redelivered.
      return Response.json({ error: "Couldn't handle the pull request" }, { status: 503 });
    }
  }
  // Published releases: the github-release job closes the changelog's running draft.
  if (event === "release" && payload.action === "published" && payload.installation) {
    const { release, repository } = payload as unknown as GithubReleaseEvent;
    try {
      await enqueue("githubRelease", {
        installationId: payload.installation.id,
        repoId: repository.id,
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

type GithubRepository = { id: number; full_name: string };

type GithubRepositoriesEvent = { repositories_removed?: GithubRepository[] };

type GithubReleaseEvent = {
  release: { tag_name: string; name: string | null; html_url: string; published_at: string | null };
  repository: GithubRepository;
};

type GithubPullRequestEvent = {
  pull_request: {
    number: number;
    title: string;
    body: string | null;
    html_url: string;
    merged?: boolean;
    labels?: { name: string }[];
  };
  repository: GithubRepository;
};
