import { sendTry } from "@/server/api-try";

/** Try it through Tuti: the reader's request to the team's API, when the API doesn't take it from a browser (server/api-try.ts). */
export async function POST(request: Request, { params }: RouteContext<"/portal/[project]/docs/[slug]/[operation]/try">) {
  const { project, slug, operation } = await params;
  return sendTry(request, project, slug, operation);
}
