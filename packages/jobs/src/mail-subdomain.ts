import { prisma } from "@tuti/db";

/**
 * The project's mail subdomain, chosen from its slug the first time (with a number added if that's
 * taken: `acme-2`), and its for good: it doesn't follow slug changes, and nobody else ever gets it.
 */
export async function mailSubdomain(projectId: string): Promise<string> {
  const existing = await prisma.mailSubdomain.findUnique({ where: { projectId }, select: { subdomain: true } });
  if (existing) {
    return existing.subdomain;
  }
  const { slug } = await prisma.project.findUniqueOrThrow({ where: { id: projectId }, select: { slug: true } });
  for (let n = 1; ; n++) {
    const subdomain = n === 1 ? slug : `${slug}-${n}`;
    const taken = await prisma.mailSubdomain.findUnique({ where: { subdomain }, select: { projectId: true } });
    if (taken) {
      if (taken.projectId === projectId) {
        return subdomain;
      }
      continue;
    }
    try {
      await prisma.mailSubdomain.create({ data: { subdomain, projectId } });
      return subdomain;
    } catch {
      // Taken meanwhile (by another project, or this one in another request): look again.
      const mine = await prisma.mailSubdomain.findUnique({ where: { projectId }, select: { subdomain: true } });
      if (mine) {
        return mine.subdomain;
      }
    }
  }
}
