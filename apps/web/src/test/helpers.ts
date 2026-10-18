import { randomUUID } from "node:crypto";

import { type TeamRole, prisma } from "@tuti/db";

import { auth } from "@/lib/auth";

import { request } from "./next-headers";

/** Helpers for database tests (*.db.test.ts). Each test file has its own database. */

export type TestUser = { id: string; email: string; cookie: string };

/** Signs up a new user through Better Auth. */
export async function signUp(name = "Test user"): Promise<TestUser> {
  const email = `e2e-${randomUUID()}@example.com`;
  const { headers, response } = await auth.api.signUpEmail({
    body: { email, name, password: "correct horse battery staple" },
    returnHeaders: true,
  });
  const cookie = headers
    .getSetCookie()
    .map((c) => c.split(";")[0])
    .join("; ");
  return { id: response.user.id, email, cookie };
}

/** Server actions called after this run as `user`; `null` means signed out. */
export function actAs(user: TestUser | null) {
  request.cookie = user?.cookie ?? "";
}

/** A project owned by `owner`, with one board ("feature-requests"). */
export async function createProject(owner: TestUser) {
  const slug = `p-${randomUUID().slice(0, 8)}`;
  return prisma.project.create({
    data: {
      slug,
      name: `Project ${slug}`,
      team: { create: { userId: owner.id, role: "OWNER" } },
      boards: { create: { slug: "feature-requests", name: "Feature requests" } },
    },
    include: { boards: true, team: true },
  });
}

/** A new user on the project's team with `role`. */
export async function addMember(projectId: string, role: TeamRole) {
  const user = await signUp(`${role.toLowerCase()} user`);
  const member = await prisma.teamMember.create({ data: { projectId, userId: user.id, role } });
  return { ...user, memberId: member.id };
}

/** Where a server action redirected to (it throws Next.js's redirect error). */
export async function redirectTarget(action: Promise<unknown>): Promise<string> {
  const error: unknown = await action.then(
    () => undefined,
    (e: unknown) => e,
  );
  const digest = (error as { digest?: string } | undefined)?.digest ?? "";
  if (!digest.startsWith("NEXT_REDIRECT;")) {
    throw new Error("Expected the action to redirect", { cause: error });
  }
  return digest.split(";")[2]!;
}
