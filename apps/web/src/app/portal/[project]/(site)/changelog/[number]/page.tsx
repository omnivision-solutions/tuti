import { prisma } from "@tuti/db";
import { MESSAGES } from "@tuti/shared/messages";
import { mediaStorage } from "@tuti/shared/storage";
import { LanguagesIcon, MessageCircleIcon } from "lucide-react";
import { createTranslator } from "next-intl";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { cache } from "react";

import { BackLink } from "@/components/back-link";
import { ChangelogComment } from "@/components/changelog-comment";
import { ChangelogEntryView } from "@/components/changelog-entry";
import { CommentForm } from "@/components/comment-form";
import { CommentList } from "@/components/comments";
import { PortalAvatar } from "@/components/portal-avatar";
import { SignInLink } from "@/components/sign-in-link";
import { buttonVariants } from "@/components/ui/button";
import { commentOnChangelogEntry } from "@/server/changelog";
import { displayDoc } from "@/server/content";
import { canActIn } from "@/server/membership";
import { ChangelogMenu, changelogByEmail } from "@/components/changelog-pages";
import { currentEntryVersions, entryAddresses, entryLanguageAsked, publishedEntries } from "@/server/changelog-queries";
import { getSession } from "@/server/session";
import { slugReader } from "@/server/portal-access";
import { visibleEntry } from "@/lib/reader-groups";
import { portalLanguage, portalLinkBase, portalLinks, teamLanguage } from "@/server/portal-base";
import { portalTranslator } from "@/server/portal-language";
import { mediaUrls, shareImage } from "@/server/media-urls";
import { portalArticleJsonLd, portalPageMetadata } from "@/server/portal-metadata";
import { summary } from "@/lib/article-links";
import { COMMENTS_HEADING } from "@/lib/comment-threads";

/**
 * A published entry's search listing, once per request (its metadata and its page's JSON-LD), if it's for whoever's reading:
 * its title and text in the page's language where it's translated there (docs/plan.md L17), and where it reads in each
 * language it's in (`addresses`: its canonical and `hreflang`).
 */
const listedEntry = cache(async (project: string, number: string) => {
  if (!/^\d{1,9}$/.test(number)) {
    return null;
  }
  const entry = await prisma.changelogEntry.findFirst({
    where: { project: { slug: project }, number: Number(number), publishedAt: { not: null }, ...visibleEntry(await slugReader(project)) },
    select: {
      id: true,
      number: true,
      title: true,
      body: true,
      content: true,
      publishedAt: true,
      sample: true,
      cover: { select: { id: true, status: true, width: true, height: true } },
      groups: { select: { groupId: true }, take: 1 },
      project: { select: { language: true } },
    },
  });
  if (!entry) {
    return null;
  }
  const asked = await entryLanguageAsked();
  const [version, addresses] = await Promise.all([
    asked ? currentEntryVersions([entry], [asked]).then((versions) => versions.get(entry.id)?.[0]) : undefined,
    entryAddresses(project, { ...entry, projectLanguage: entry.project.language }),
  ]);
  return { ...entry, ...(version && { title: version.title, body: version.body }), translated: !!version, addresses };
});

/**
 * An entry's search listing and link card; sample content (server/sample-content.ts) and an entry for some groups only are
 * kept from search engines.
 */
export async function generateMetadata(props: PageProps<"/portal/[project]/changelog/[number]">): Promise<Metadata> {
  const { project, number } = await props.params;
  const entry = await listedEntry(project, number);
  if (!entry) {
    return {};
  }
  return portalPageMetadata(project, {
    title: entry.title,
    description: summary(entry.body),
    path: `/changelog/${Number(number)}`,
    addresses: entry.addresses,
    article: { publishedTime: entry.publishedAt },
    noindex: entry.sample || entry.groups.length > 0,
    // Its Markdown copy is for everyone only (it's kept in shared caches).
    markdown: entry.groups.length === 0,
    // Its featured image, once processed, is its link card.
    image: shareImage(entry.cover),
  });
}

export default async function ChangelogEntryPage(props: PageProps<"/portal/[project]/changelog/[number]">) {
  const { project: slug, number: param } = await props.params;
  const number = Number(param);
  if (!Number.isInteger(number) || number < 1) {
    notFound();
  }
  const [session, reader] = await Promise.all([getSession(), slugReader(slug)]);
  const [[entry], project] = await Promise.all([
    // In the page's language where it's translated there, else the default language's (docs/plan.md L17).
    publishedEntries(slug, reader, { number, take: 1, userId: session?.user.id, language: await entryLanguageAsked() }),
    prisma.project.findUnique({ where: { slug }, select: { id: true, name: true, portalAccess: true } }),
  ]);
  if (!entry || !project) {
    notFound();
  }
  const [comments, team, commenter] = await Promise.all([
    prisma.changelogComment.findMany({
      where: { entryId: entry.id },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      select: { id: true, body: true, content: true, createdAt: true, asReader: true, author: { select: { id: true, name: true, image: true } } },
    }),
    prisma.teamMember.findMany({ where: { projectId: project.id }, select: { userId: true } }),
    // As reacting checks it: someone signed in through another project's single sign-on can't comment here.
    session && canActIn(session.user.id, project.id),
  ]);
  const commentMedia = await mediaUrls(...comments.map(displayDoc));
  // Images only once signed in: uploads are someone's. Those already in a comment show in its editor.
  const uploads = commenter && mediaStorage() ? { projectSlug: slug, mediaUrls: commentMedia ?? {} } : undefined;
  // For search engines; sample content and an entry for some groups only aren't for them, as in generateMetadata.
  const [listed, { prefix }] = await Promise.all([listedEntry(slug, param), portalLanguage()]);
  const jsonLd =
    listed &&
    !listed.sample &&
    listed.groups.length === 0 &&
    (await portalArticleJsonLd(slug, {
      type: "BlogPosting",
      title: listed.title,
      description: summary(listed.body),
      // Its address in the page's language where it's translated there (its canonical), else the default language's.
      path: `${listed.translated ? prefix : ""}/changelog/${number}`,
      // Its publishing date alone: emails going out change updatedAt too.
      published: listed.publishedAt,
    }));
  // The entry's and its comments' words: the team's and people's, in the default language under another's address
  // (teamLanguage); not the portal's own text around them.
  const lang = await teamLanguage();
  // The portal's own words in the page's language.
  const [{ t, language }, { t: f }] = await Promise.all([portalTranslator(project.id, "changelog"), portalTranslator(project.id, "feedback")]);
  // Not in the page's language yet: shown in the default language's, with a line in the page's saying so (docs/plan.md, "A
  // page not yet translated", as an article's).
  const notTranslated = entry.untranslated ? createTranslator({ locale: language, messages: MESSAGES[language], namespace: "docs" })("notTranslated") : null;
  return (
    <div className="flex flex-col gap-6">
      {jsonLd}
      <ChangelogMenu slug={slug} current={entry.number} />
      {notTranslated && (
        <p lang={language} className="flex items-start gap-2 rounded-lg bg-secondary px-3 py-2 text-sm text-muted-foreground">
          <LanguagesIcon aria-hidden className="mt-0.5 size-4 shrink-0" />
          {notTranslated}
        </p>
      )}
      <ChangelogEntryView
        entry={entry}
        back={<BackLink href={(await portalLinks())("/changelog")}>{MESSAGES[language].header.changelog}</BackLink>}
        mediaUrls={await mediaUrls(entry.doc, entry.cover)}
        heading="h1"
        react={{ projectSlug: slug, signedIn: !!session }}
        base={await portalLinkBase()}
        lang={lang}
        language={language}
      />
      <section className="flex flex-col gap-3 border-t pt-8" aria-label={f("commentsLabel")}>
        <h2 id={COMMENTS_HEADING} tabIndex={-1} className="font-sans text-lg font-semibold outline-none">
          {f("comments", { count: comments.length })}
        </h2>
        {/* The box before the thread; signed out, a bar to sign in instead. */}
        {commenter && session ? (
          <div className="flex gap-3 border-b pb-5">
            <PortalAvatar person={{ name: session.user.name, image: session.user.image ?? null }} className="size-8 text-[0.8125rem]" />
            <div className="min-w-0 flex-1">
              <CommentForm postId={entry.id} action={commentOnChangelogEntry.bind(null, slug, entry.number)} signedIn uploads={uploads} />
            </div>
          </div>
        ) : (
          !session && (
            <div className="flex flex-col gap-4 rounded-xl bg-muted p-5 sm:flex-row sm:items-center sm:py-4">
              <span aria-hidden className="hidden size-10 shrink-0 place-items-center rounded-lg bg-card text-muted-foreground sm:grid">
                <MessageCircleIcon className="size-[1.125rem]" />
              </span>
              <p className="min-w-0 flex-1 text-[0.9375rem] text-muted-foreground">{t("signInToComment")}</p>
              <SignInLink className={buttonVariants({ variant: "outline", size: "lg", className: "font-semibold portal:bg-card portal:hover:bg-card/70" })}>
                {MESSAGES[language].header.signIn}
              </SignInLink>
            </div>
          )
        )}
        <div className="pt-3">
          <CommentList
            lang={lang}
            language={language}
            portal
            comments={comments}
            teamUserIds={new Set(team.map((m) => m.userId))}
            mediaUrls={commentMedia}
            // Its author edits or deletes their own (the team deletes any from the app, where it's the team).
            editable={(comment, text) => (
              <ChangelogComment
                projectSlug={slug}
                number={entry.number}
                commentId={comment.id}
                author={comment.author.name}
                doc={displayDoc(comment)}
                canEdit={!!commenter && comment.author.id === session?.user.id}
                canDelete={!!commenter && comment.author.id === session?.user.id}
                uploads={uploads}
              >
                {text}
              </ChangelogComment>
            )}
          />
        </div>
      </section>
      {/* After reading: the way to hear about the next one. */}
      <div className="mt-4 border-t pt-8">{await changelogByEmail({ ...project, slug }, session)}</div>
    </div>
  );
}
