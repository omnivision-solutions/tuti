import { prisma } from "@tuti/db";

import { PAGE_SIZE } from "@/components/changelog-pages";
import { STATUS_LABELS } from "@/components/post-status-badge";
import { formatDate } from "@/lib/format";
import { DOCS_HEADING } from "@/lib/portal-look";
import { postNumberFromParam } from "@/lib/post-urls";
import { entryLanguageAsked, publishedEntries } from "@/server/changelog-queries";
import { portalAddress } from "@/server/custom-domains";
import { type ApiReferencePage, apiReferencePage } from "@/server/api-reference-queries";
import { articleCount, type DocsPage, docsHome, docsPage, type TabLanding } from "@/server/docs-queries";
import { canReadPortal, currentPostViewer, currentReader, mayRead, slugReader } from "@/server/portal-access";
import { portalSite } from "@/server/portal-metadata";
import { canSeePost, seesBoard, visiblePosts } from "@/server/post-visibility";
import { type ShareCard, shareCard } from "@/server/share-card";

/**
 * A portal page's link card (server/share-card.tsx): /og<the page's path>, e.g. /og/docs/billing. The page's own
 * rules decide what it shows (as its metadata does): a page this reader can't open has no card, and on a private
 * portal only its readers get one (proxy.ts sends everyone else to sign in; checked here too). Shared caches may keep
 * only what anyone signed out sees.
 */
export async function GET(_request: Request, { params }: RouteContext<"/portal/[project]/og/[[...path]]">) {
  const { project: slug, path = [] } = await params;
  const site = await portalSite(slug);
  if (!site || !(await mayRead(site.project.id))) {
    return notFound();
  }
  const card = await cardFor(slug, site, path);
  if (!card) {
    return notFound();
  }
  const [address, reader, viewer, open] = await Promise.all([
    portalAddress(slug),
    currentReader(site.project.id),
    currentPostViewer(site.project.id),
    canReadPortal({ id: site.project.id }, null),
  ]);
  // What anyone signed out sees: a public portal, read with no session, preview or widget reader.
  const signedOut = open && reader !== null && !reader.signedIn && !viewer.userId;
  // ponytail: an hour's public copy at most; a page made private since shows its old card that long, as the sitemap does its links.
  const cacheControl = signedOut ? "public, max-age=3600" : "private, no-store";
  return shareCard(site, card, address, { "cache-control": cacheControl });
}

const notFound = () => new Response("Not found", { status: 404, headers: { "cache-control": "private, no-store" } });

type Site = NonNullable<Awaited<ReturnType<typeof portalSite>>>;

async function cardFor(slug: string, site: Site, path: string[]): Promise<ShareCard | null> {
  const [part, ...rest] = path;
  switch (part) {
    case undefined:
      // The portal itself: its search listing's description under its title, else its title.
      return site.brand.seo.description ? { eyebrow: site.name, title: site.brand.seo.description, picture: "page" } : { eyebrow: "", title: site.name, picture: "page" };
    case "docs":
      return rest.length === 0
        ? docsCard(site, await docsHome(slug))
        : rest.length === 1
          ? (docsPageCard(site, await docsPage(slug, rest[0]!)) ?? referenceCard(await apiReferencePage(slug, rest[0]!)))
          : rest.length === 2
            ? operationCard(await apiReferencePage(slug, rest[0]!), rest[1]!)
            : null;
    case "feedback":
      return feedbackCard(site.project.id, rest);
    case "roadmap":
      return rest.length === 0 ? roadmapCard(site.project.id) : null;
    case "changelog":
      return changelogCard(slug, site, rest);
    default:
      return null;
  }
}

/** /docs: what it shows (the first tab's article or collection in its place, else the docs' home). */
function docsCard(site: Site, home: Awaited<ReturnType<typeof docsHome>>): ShareCard {
  return landingCard(home.landing) ?? { eyebrow: "Documentation", title: site.brand.docsHome.title || DOCS_HEADING.title, picture: "page" };
}

function landingCard(landing: TabLanding): ShareCard | null {
  return landing.kind === "overview" ? null : docsPageCard(null, landing);
}

/** An API reference's own page: its name (a locked one's too, as a locked article's). */
function referenceCard(page: ApiReferencePage | null): ShareCard | null {
  return page && { eyebrow: "Documentation", title: page.reference.name, picture: "page" };
}

/** An API reference's operation: its title under the reference's name (a locked one's too, as a locked article's). */
function operationCard(page: ApiReferencePage | null, slug: string): ShareCard | null {
  const title = page?.operations.find((operation) => operation.slug === slug)?.title;
  return page && title !== undefined ? { eyebrow: `Documentation · ${page.reference.name}`, title, picture: "page" } : null;
}

function docsPageCard(site: Site | null, page: DocsPage | TabLanding | null): ShareCard | null {
  switch (page?.kind) {
    case "article": {
      const { article } = page;
      return {
        eyebrow: article.collection ? `Documentation · ${article.collection.name}` : "Documentation",
        title: article.title,
        facts: article.updatedAt ? [`Updated ${formatDate(article.updatedAt)}`] : [],
        picture: "page",
      };
    }
    case "locked":
      return { eyebrow: page.article.collection ? `Documentation · ${page.article.collection.name}` : "Documentation", title: page.article.title, picture: "page" };
    case "collection": {
      const count = articleCount(page.collection);
      return { eyebrow: "Documentation", title: page.collection.name, facts: count ? [plural(count, "article")] : [], picture: "page" };
    }
    case "reference":
      return { eyebrow: "Documentation", title: page.name, picture: "page" };
    case "tab":
      return (page.tab.locked ? null : landingCard(page.landing)) ?? { eyebrow: "Documentation", title: page.tab.name, picture: "page" };
    case "overview":
      return site && { eyebrow: "Documentation", title: site.brand.docsHome.title || DOCS_HEADING.title, picture: "page" };
    default:
      return null;
  }
}

async function feedbackCard(projectId: string, [board, post, ...more]: string[]): Promise<ShareCard | null> {
  const viewer = await currentPostViewer(projectId);
  if (!board) {
    return { eyebrow: "Feedback", title: "Vote for the ideas you want most, or share your own.", picture: "board" };
  }
  if (more.length) {
    return null;
  }
  if (!post) {
    const found = await prisma.board.findUnique({
      where: { projectId_slug: { projectId, slug: board } },
      select: { name: true, postVisibility: true, off: true, _count: { select: { posts: { where: { duplicateOfId: null, ...visiblePosts(viewer) } } } } },
    });
    return found && seesBoard(viewer, found) ? { eyebrow: "Feedback", title: found.name, facts: found._count.posts ? [plural(found._count.posts, "idea")] : [], picture: "board" } : null;
  }
  const number = postNumberFromParam(post);
  const found =
    number === null
      ? null
      : await prisma.post.findFirst({
          where: { projectId, number, duplicateOfId: null },
          select: {
            title: true,
            status: true,
            voteCount: true,
            visibility: true,
            authorId: true,
            board: { select: { name: true, off: true, postVisibility: true } },
            _count: { select: { comments: true } },
          },
        });
  if (!found || !canSeePost(viewer, found)) {
    return null;
  }
  return {
    // A Team only board's name is the team's, as on the post's page.
    eyebrow: seesBoard(viewer, found.board) ? found.board.name : "Feedback",
    title: found.title,
    facts: [STATUS_LABELS[found.status], plural(found.voteCount, "vote"), ...(found._count.comments ? [plural(found._count.comments, "comment")] : [])],
    picture: { votes: found.voteCount },
  };
}

async function roadmapCard(projectId: string): Promise<ShareCard> {
  const viewer = await currentPostViewer(projectId);
  // As the roadmap's columns (roadmapColumns): a public idea on a Team only board is on it too.
  const counts = await prisma.post.groupBy({
    by: ["status"],
    where: { projectId, duplicateOfId: null, status: { in: ["PLANNED", "IN_PROGRESS"] }, ...visiblePosts(viewer) },
    _count: { _all: true },
  });
  const count = (status: string) => counts.find((row) => row.status === status)?._count._all ?? 0;
  const facts = [count("PLANNED") && `${count("PLANNED")} planned`, count("IN_PROGRESS") && `${count("IN_PROGRESS")} in progress`].filter((fact): fact is string => !!fact);
  return { eyebrow: "Roadmap", title: "What's planned, what we're building and what's done.", facts, picture: "roadmap" };
}

async function changelogCard(slug: string, site: Site, rest: string[]): Promise<ShareCard | null> {
  // /changelog and its later pages (/changelog/page/2), as their pages: one address each, and none past the last.
  if (rest.length === 2 && rest[0] === "page") {
    const page = Number(rest[1]);
    if (!Number.isInteger(page) || String(page) !== rest[1] || page < 2 || page > 10_000) {
      return null;
    }
    if (!(await publishedEntries(slug, await slugReader(slug), { take: 1, skip: (page - 1) * PAGE_SIZE })).length) {
      return null;
    }
  } else if (rest.length !== 0) {
    return changelogEntryCard(slug, rest);
  }
  const [latest] = await publishedEntries(slug, await slugReader(slug), { take: 1 });
  return { eyebrow: "Changelog", title: `What's new, improved and fixed in ${site.project.name}.`, facts: latest?.publishedAt ? [`Latest ${formatDate(latest.publishedAt)}`] : [], picture: "changelog" };
}

async function changelogEntryCard(slug: string, rest: string[]): Promise<ShareCard | null> {
  if (rest.length !== 1 || !/^\d{1,9}$/.test(rest[0]!)) {
    return null;
  }
  // Whoever's asking: the card of an entry for some groups is only for them (and never kept in shared caches, as they're signed in).
  // At a language's address (/de/og/changelog/7), its title there where it's translated (docs/plan.md L17).
  const [entry] = await publishedEntries(slug, await slugReader(slug), { number: Number(rest[0]), take: 1, language: await entryLanguageAsked() });
  return entry ? { eyebrow: "Changelog", title: entry.title, facts: entry.publishedAt ? [formatDate(entry.publishedAt)] : [], picture: "changelog" } : null;
}

const plural = (n: number, word: string) => `${n.toLocaleString("en")} ${word}${n === 1 ? "" : "s"}`;
