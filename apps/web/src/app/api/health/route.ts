import { prisma } from "@tuti/db";

/** For the host's health check (Coolify, Docker, a load balancer): up only if the database answers. */
export async function GET() {
  try {
    await prisma.$queryRaw`SELECT 1`;
    return Response.json({ ok: true });
  } catch {
    return Response.json({ ok: false }, { status: 503 });
  }
}
