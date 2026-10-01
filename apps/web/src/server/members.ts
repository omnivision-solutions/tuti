import { prisma } from "@tuti/db";

import { getSession } from "./session";

/** The workspace, if the signed-in user is one of its owners or admins. */
export async function getAdminWorkspace(slug: string) {
  const session = await getSession();
  if (!session) {
    return null;
  }
  const member = await prisma.member.findFirst({
    where: { userId: session.user.id, role: { in: ["OWNER", "ADMIN"] }, workspace: { slug } },
    select: { workspace: { select: { id: true, slug: true, name: true, ssoSecret: true } } },
  });
  return member?.workspace ?? null;
}
