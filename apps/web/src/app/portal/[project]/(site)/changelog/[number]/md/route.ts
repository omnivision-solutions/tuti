import { prisma } from "@tuti/db";

import { formatDate } from "@/lib/format";
import { SIGNED_OUT } from "@/lib/read-access";
import { visibleEntry } from "@/lib/reader-groups";
import { displayDoc } from "@/server/content";
import { portalAddress } from "@/server/custom-domains";
import { articleMarkdown } from "@/server/docs-queries";

/** A published changelog entry as Markdown, at /changelog/<number>.md (proxy.ts sends it here), for AI tools: its title, date and content. */
export async function GET(_request: Request, { params }: RouteContext<"/portal/[project]/changelog/[number]/md">) {
  const { project, number } = await params;
  const entry = /^\d{1,9}$/.test(number)
    ? await prisma.changelogEntry.findFirst({
        // For everyone only, as it's kept in shared caches: an entry for some groups is on its page alone.
        where: { project: { slug: project }, number: Number(number), publishedAt: { not: null }, ...visibleEntry(SIGNED_OUT) },
        select: { title: true, body: true, content: true, publishedAt: true, sample: true },
      })
    : null;
  if (!entry) {
    return new Response("Not found", { status: 404 });
  }
  const doc = displayDoc(entry);
  const date = { type: "paragraph", content: [{ type: "text", text: formatDate(entry.publishedAt!) }] };
  return new Response(await articleMarkdown({ title: entry.title, doc: { ...doc, content: [date, ...(doc.content ?? [])] } }), {
    headers: {
      "content-type": "text/markdown; charset=utf-8",
      // As the RSS feed: a published entry is for everyone who may read the portal (a private one's, proxy.ts keeps from shared caches).
      "cache-control": "public, max-age=300",
      // Search engines index the entry's page, not this copy of it.
      link: `<${await portalAddress(project)}/changelog/${Number(number)}>; rel="canonical"`,
      // Sample content (server/sample-content.ts) isn't for search engines.
      ...(entry.sample && { "x-robots-tag": "noindex" }),
    },
  });
}
