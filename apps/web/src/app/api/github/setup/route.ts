import { prisma } from "@tuti/db";
import { NextResponse } from "next/server";

import { githubConfig, installationForUser, verifyInstallState } from "@/lib/github";
import { appUrl } from "@/lib/hosts";
import { getAccountSession } from "@/server/session";

/**
 * Where GitHub sends people after installing the Tuti App. The installation is
 * connected to the project in `state` only if the signed-in account is one of its
 * owners or admins, and GitHub confirms (through the user authorization `code`)
 * that this person can see the installation, so nobody can claim someone else's.
 */
export async function GET(request: Request) {
  const config = githubConfig();
  if (!config) {
    return new NextResponse(null, { status: 404 });
  }
  const params = new URL(request.url).searchParams;
  const session = await getAccountSession();
  if (!session) {
    const back = `/api/github/setup?${params}`;
    return NextResponse.redirect(new URL(`/sign-in?${new URLSearchParams({ next: back })}`, appUrl()));
  }

  const projectId = verifyInstallState(params.get("state") ?? "");
  const project =
    projectId &&
    (await prisma.project.findFirst({
      where: { id: projectId, team: { some: { userId: session.user.id, role: { in: ["OWNER", "ADMIN"] } } } },
      select: { id: true, slug: true },
    }));
  if (!project) {
    return NextResponse.redirect(new URL("/app?github=expired", appUrl()));
  }
  const settings = (result: string) =>
    NextResponse.redirect(new URL(`/app/${project.slug}/settings?github=${result}`, appUrl()));

  const installationId = Number(params.get("installation_id"));
  const code = params.get("code");
  if (!Number.isSafeInteger(installationId) || installationId <= 0 || !code) {
    return settings("unconfirmed");
  }
  const account = await installationForUser(config, code, installationId).catch(() => null);
  if (!account) {
    return settings("unconfirmed");
  }
  const taken = await prisma.githubInstallation.findUnique({ where: { installationId }, select: { projectId: true } });
  if (taken && taken.projectId !== project.id) {
    return settings("taken");
  }

  await prisma.githubInstallation.upsert({
    where: { projectId: project.id },
    update: { installationId, accountLogin: account.login, createdById: session.user.id },
    create: { projectId: project.id, installationId, accountLogin: account.login, createdById: session.user.id },
  });
  return settings("connected");
}
