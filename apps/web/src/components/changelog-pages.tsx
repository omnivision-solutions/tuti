import { prisma, type ChangelogTag } from "@tuti/db";
import { MESSAGES } from "@tuti/shared/messages";
import { emailConfigured } from "@tuti/email";
import { ArrowLeftIcon, ArrowRightIcon, BellIcon, ChevronDownIcon, RssIcon } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

import { ChangelogEntryView } from "@/components/changelog-entry";
import { TAG_LABELS } from "@/components/changelog-tag";
import { ChangelogSeen } from "@/components/changelog-seen";
import { ChangelogSubscribe } from "@/components/changelog-subscribe";
import { EmptyState } from "@/components/empty-state";
import { Button, buttonVariants } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { FilterPills } from "@/components/filter-pills";
import { PortalPageHeader } from "@/components/portal-page-header";
import { portalAddress } from "@/server/custom-domains";
import { PortalMenuPart } from "@/components/portal-menu";
import { dateLocale, formatDate } from "@/lib/format";
import { cn } from "@/lib/utils";
import { changelogContents, changelogDates, publishedEntries } from "@/server/changelog-queries";
import { reachSentence } from "@/server/changelog-subscription";
import { accountEmails } from "@/server/operations/email-preferences";
import { latestAnnouncement } from "@/server/operations/changelog-seen";
import { getSession } from "@/server/session";
import { slugReader } from "@/server/portal-access";
import { portalLanguage, portalLinkBase, portalLinks, teamLanguage } from "@/server/portal-base";
import { portalTranslator } from "@/server/portal-language";
import { portalPageMetadata, portalSite } from "@/server/portal-metadata";
import { mediaUrls } from "@/server/media-urls";

export const PAGE_SIZE = 20;

/** More entries than a screen shows: the list gets a month index beside it to jump through them. */
const MONTH_INDEX_FROM = 9;

/** The month index's months shown at first; older ones under "Earlier months". */
const RECENT_MONTHS = 6;

/** A changelog page's path: /changelog, then /changelog/page/2 and on; `?tag=new` with a tag's chip picked. */
export const changelogPath = (page: number, tag?: ChangelogTag) =>
  `${page === 1 ? "/changelog" : `/changelog/page/${page}`}${tag ? `?tag=${tag.toLowerCase()}` : ""}`;

/** The tag `?tag=` names ("new", "improved", "fixed", "breaking"); anything else is none. */
export function changelogTag(param: string | string[] | undefined): ChangelogTag | undefined {
  return (Object.keys(TAG_LABELS) as ChangelogTag[]).find((tag) => tag.toLowerCase() === param);
}

/** "October 2026" in the page's `language` (UTC, as `formatDate`); its key "2026-10" is the anchor of its first entry on the list. */
const monthOf = (date: Date, language = "en") => ({
  key: date.toISOString().slice(0, 7),
  label: date.toLocaleDateString(dateLocale(language), { month: "long", year: "numeric", timeZone: "UTC" }),
});

/**
 * On a changelog page, the header's menu (on phones and tablets) lists the newest entries by date,
 * each with its title, `current` (an entry's number, on its page) marked; then all of them.
 */
export async function ChangelogMenu({ slug, current }: { slug: string; current?: number }) {
  const [at, entries, lang, project] = await Promise.all([
    portalLinks(),
    slugReader(slug).then((reader) => changelogContents(slug, reader)),
    teamLanguage(),
    prisma.project.findUnique({ where: { slug }, select: { id: true } }),
  ]);
  if (entries.length === 0 || !project) {
    return null;
  }
  const { t, language } = await portalTranslator(project.id, "changelog");
  return (
    <PortalMenuPart>
      <nav aria-label={t("entries")} className="flex flex-col gap-0.5 text-sm">
        <Link href={at("/changelog")} className="px-2 py-1 font-heading font-semibold">
          {MESSAGES[language].header.changelog}
        </Link>
        {entries.map((entry) => {
          const active = entry.number === current;
          return (
            <Link
              key={entry.number}
              href={at(`/changelog/${entry.number}`)}
              aria-current={active ? "page" : undefined}
              className={`flex flex-col rounded-md px-2 py-1.5 ${active ? "bg-accent" : "hover:bg-muted"}`}
            >
              <time dateTime={entry.publishedAt!.toISOString()} className={active ? "font-medium" : "text-muted-foreground"}>
                {formatDate(entry.publishedAt!, language)}
              </time>
              {/* The team's words (lang). */}
              <span lang={lang} className="text-xs break-words text-muted-foreground">
                {entry.title}
              </span>
            </Link>
          );
        })}
      </nav>
    </PortalMenuPart>
  );
}

/** A page of the changelog (`page`: 1 for /changelog); feed readers find the RSS feed from it: a full URL on the project's portal. */
export async function changelogMetadata(slug: string, page = 1): Promise<Metadata> {
  const [site, address, project, { prefix }] = await Promise.all([
    portalSite(slug),
    portalAddress(slug),
    prisma.project.findUnique({ where: { slug }, select: { id: true } }),
    portalLanguage(),
  ]);
  if (!project) {
    return {};
  }
  const { t, language } = await portalTranslator(project.id, "changelog");
  const title = MESSAGES[language].header.changelog;
  const metadata = await portalPageMetadata(slug, {
    title,
    description: changelogDescription(t, site?.project.name),
    path: page > 1 ? `/changelog/page/${page}` : "/changelog",
  });
  return { ...metadata, alternates: { ...metadata.alternates, types: { "application/rss+xml": [{ url: `${address}${prefix}/changelog/rss.xml`, title }] } } };
}

/** Under the changelog's title. */
const changelogDescription = (t: Awaited<ReturnType<typeof portalTranslator<"changelog">>>["t"], name: string | undefined) =>
  name ? t("description", { name }) : t("descriptionBare");

/**
 * The changelog by email (subscribeToChangelog; a private portal's pages are its readers' only), where email is set up: a signed-in reader's
 * standing as their Account has it (accountEmails), so the pages agree; otherwise the form to subscribe. `inCard`: in a
 * card that has its own heading (a board's Get updates). A function the pages await, not a component, so they render
 * in one pass.
 */
export async function changelogByEmail(
  project: { id: string; name: string; slug: string; portalAccess: string },
  session: Awaited<ReturnType<typeof getSession>>,
  inCard = false,
  bare = false,
) {
  if (!emailConfigured()) {
    return null;
  }
  const [emails, { t, language }] = await Promise.all([session ? accountEmails(project.id, session.user.id) : null, portalTranslator(project.id, "changelog")]);
  // Where they stand, as the subscription pages say it: getting it (or will, once paused emails resume), or their own
  // opt-out (another account's at the address isn't theirs to undo on Account: they get the form).
  const { email, reach, proven } = emails?.changelog ?? {};
  if (email && reach && (emails?.preferences.changelog || (emails?.preferences.unsubscribed && proven && reach === "opted-out"))) {
    return (
      <p className="text-sm break-words text-muted-foreground">
        {reachSentence(reach, project.name, email, language)}{" "}
        <Link href={(await portalLinks())("/account")} className="text-foreground underline underline-offset-4">
          {t("manage")}
        </Link>
      </p>
    );
  }
  // Their address filled in, unless it's a stand-in (".invalid": an account without one).
  return <ChangelogSubscribe projectSlug={project.slug} email={session?.user.email.endsWith(".invalid") ? undefined : session?.user.email} inCard={inCard} bare={bare} />;
}

/**
 * What shipped, newest first, a page at a time (/changelog, then /changelog/page/2 for older ones); with `tag`
 * (its chip, `?tag=`) only the entries with it. Past the last page it's a 404: a function the pages call, not a
 * component, so that happens before they render.
 */
export async function changelogPage(slug: string, page: number, tag?: ChangelogTag) {
  const at = await portalLinks();
  const [base, lang] = await Promise.all([portalLinkBase(), teamLanguage()]);
  // One more than a page, to know whether there are older ones.
  const [session, reader] = await Promise.all([getSession(), slugReader(slug)]);
  const [found, announced, dates, project] = await Promise.all([
    publishedEntries(slug, reader, { tag, take: PAGE_SIZE + 1, skip: (page - 1) * PAGE_SIZE, userId: session?.user.id }),
    session ? latestAnnouncement({ slug }, reader) : null,
    changelogDates(slug, reader),
    prisma.project.findUnique({ where: { slug }, select: { id: true, name: true, portalAccess: true } }),
  ]);
  if (!project) {
    notFound();
  }
  const entries = found.slice(0, PAGE_SIZE);
  // The portal's words in the page's language.
  const { t, language } = await portalTranslator(project.id, "changelog");
  if (entries.length === 0 && page > 1) {
    notFound();
  }
  const older = found.length > PAGE_SIZE;
  // A signed-in reader has seen the latest announcement (the nav's "New" goes) on the first page, as it's what's new, and on
  // any other page (older, or a tag's) that shows that very entry. Seen is a time, so only ever that entry's own.
  const seen =
    announced && ((page === 1 && !tag) || entries.some((entry) => entry.id === announced.id)) ? announced.publishedAt! : null;
  // The list shows every entry's cover (and its text as an excerpt).
  const media = await mediaUrls(...entries.map((entry) => entry.cover));
  // A chip for each tag some entry has, in the editor's order.
  const tags = (Object.keys(TAG_LABELS) as ChangelogTag[]).filter((t) => dates.some((entry) => entry.tags.includes(t)));
  // The month index: each month the (picked) entries span, how many, and the page its newest one is on.
  const listed = tag ? dates.filter((entry) => entry.tags.includes(tag)) : dates;
  const months = new Map<string, { label: string; count: number; page: number }>();
  listed.forEach((entry, i) => {
    const { key, label } = monthOf(entry.publishedAt!, language);
    const month = months.get(key) ?? months.set(key, { label, count: 0, page: Math.floor(i / PAGE_SIZE) + 1 }).get(key)!;
    month.count++;
  });
  // The anchors: each month's first entry on this page.
  const subscribe = project && (await changelogByEmail({ ...project, slug }, session, false, true));
  // Its form (not where a reader who gets it stands): in a popover from the header's Subscribe.
  const subscribable = !!subscribe && subscribe.type === ChangelogSubscribe;
  // Beside the title on a phone, both are the size of Feedback's round buttons there.
  const rss = (phone: boolean) => (
    <a
      href={at("/changelog/rss.xml")}
      aria-label={t("rssFeed")}
      title={t("rssFeed")}
      className={buttonVariants({ variant: "outline", size: phone ? "icon-lg" : "icon", className: "rounded-full" })}
    >
      <RssIcon aria-hidden />
    </a>
  );
  // Subscribe, the page's one filled button: its form in a popover (on phones a round bell).
  const subscribeButton = (round: boolean) => (
    <Popover>
      <PopoverTrigger
        render={<Button size={round ? "icon-lg" : "default"} aria-label={round ? t("subscribe") : undefined} className={round ? "rounded-full" : "font-semibold"} />}
      >
        <BellIcon aria-hidden />
        {!round && ` ${t("subscribe")}`}
      </PopoverTrigger>
      <PopoverContent align="end" className="w-80 p-4">
        {subscribe}
      </PopoverContent>
    </Popover>
  );
  const anchors = new Map(entries.map((entry) => [monthOf(entry.publishedAt).key, entry.number] as const).reverse());
  // The month this page opens on (its first entry's), marked in the index.
  const currentMonth = entries[0] && monthOf(entries[0].publishedAt).key;
  const monthLink = (key: string, month: { label: string; count: number; page: number }) => (
    <Link
      key={key}
      href={`${at(changelogPath(month.page, tag))}#${key}`}
      // Read out as "October 2026, 3 entries", not "October 20263".
      aria-label={t("monthEntries", { month: month.label, count: month.count })}
      // Plain rows; the month this page opens on in the neutral fill.
      className={cn(
        "flex items-center gap-2 rounded-lg px-2.5 py-1.5 text-sm transition-colors",
        key === currentMonth ? "bg-accent font-medium text-foreground" : "text-muted-foreground hover:bg-muted hover:text-foreground",
      )}
    >
      <span className="min-w-0 flex-1">{month.label}</span>
      <span className="text-xs tabular-nums">{month.count.toLocaleString(language)}</span>
    </Link>
  );
  return (
    // On wide screens the month index is in a column beside the list (empty with a short history, so entries keep their width).
    <div className="flex flex-col gap-2 lg:gap-8">
      <ChangelogMenu slug={slug} />
      {seen && <ChangelogSeen projectSlug={slug} at={seen.toISOString()} signedIn />}
      {/* The tags as pills (each an address to share; picking one starts from the first page), RSS and Subscribe at the row's
          end; on phones both round, beside the title. */}
      <PortalPageHeader
        title={MESSAGES[language].header.changelog}
        description={changelogDescription(t, project?.name)}
        pills={
          tags.length > 0 && (
            <FilterPills
              label={t("tagsLabel")}
              current={at(changelogPath(1, tag))}
              items={[undefined, ...tags].map((picked) => ({
                href: at(changelogPath(1, picked)),
                title: picked ? t(`tag.${picked}`) : t("all"),
                count: (picked ? dates.filter((entry) => entry.tags.includes(picked)).length : dates.length).toLocaleString(language),
              }))}
            />
          )
        }
        actions={
          <>
            {rss(false)}
            {subscribable && subscribeButton(false)}
          </>
        }
        phoneActions={
          <>
            {rss(true)}
            {subscribable && subscribeButton(true)}
          </>
        }
      />
      {/* Without JavaScript the popover can't open: its form in the page instead. */}
      {subscribable && (
        <noscript>
          <div className="max-w-sm">{subscribe}</div>
        </noscript>
      )}
      <div className="flex flex-col gap-8 lg:grid lg:grid-cols-[minmax(0,1fr)_13rem] lg:items-start lg:gap-x-16">
        {/* Beside the list on wide screens, staying in view: the month index; and where a reader who gets it stands. */}
        {(listed.length >= MONTH_INDEX_FROM || (subscribe && !subscribable)) && (
          <aside
            aria-label={t("follow")}
            className="hidden flex-col gap-6 lg:sticky lg:top-[calc(var(--portal-header-height,0px)+2rem)] lg:col-start-2 lg:row-start-1 lg:flex lg:max-h-[calc(100dvh-var(--portal-header-height,0px)-4rem)]"
          >
            {listed.length >= MONTH_INDEX_FROM && (
              <nav aria-label={t("months")} className="flex min-h-0 flex-col overflow-y-auto">
                <h2 className="mb-2 px-2.5 text-[0.8125rem] font-medium text-muted-foreground">{t("jumpToMonth")}</h2>
                <div className="flex flex-col">
                  {[...months].slice(0, RECENT_MONTHS).map(([key, month]) => monthLink(key, month))}
                </div>
                {/* The rest folded away, so the index stays short; open on an older page whose month is among them. */}
                {months.size > RECENT_MONTHS && (
                  <details className="group/months" open={[...months.keys()].indexOf(currentMonth ?? "") >= RECENT_MONTHS}>
                    <summary className="flex cursor-pointer list-none items-center justify-between gap-1.5 rounded-lg px-2.5 py-1.5 text-sm text-muted-foreground transition-colors hover:bg-muted hover:text-foreground [&::-webkit-details-marker]:hidden">
                      {t("earlierMonths")}
                      <ChevronDownIcon aria-hidden className="size-3.5 transition-transform group-open/months:rotate-180" />
                    </summary>
                    <div className="flex flex-col">{[...months].slice(RECENT_MONTHS).map(([key, month]) => monthLink(key, month))}</div>
                  </details>
                )}
              </nav>
            )}
            {subscribe && !subscribable && subscribe}
          </aside>
        )}
        <div className="flex min-w-0 flex-col gap-8 lg:col-start-1 lg:row-start-1">
          {entries.length === 0 ? (
            tag ? (
              <EmptyState
                title={t("noTagEntries", { tag: t(`tag.${tag}`) })}
                description={t("noTagDescription")}
                action={
                  <Link href={at(changelogPath(1))} className={buttonVariants({ variant: "outline" })}>
                    {t("showAll")}
                  </Link>
                }
              />
            ) : (
              <EmptyState title={t("empty")} description={t("emptyDescription")} />
            )
          ) : (
            // On wide screens a timeline: the dates' dots on a line down the margin; a line between entries.
            <div className="relative flex flex-col lg:before:absolute lg:before:top-12 lg:before:bottom-0 lg:before:left-0 lg:before:w-px lg:before:bg-divider">
              {entries.map((entry, i) => (
                <div
                  key={entry.number}
                  id={anchors.get(monthOf(entry.publishedAt).key) === entry.number ? monthOf(entry.publishedAt).key : undefined}
                  className="flex flex-col"
                >
                  {/* Between entries, a line under the text (not across the dates' margin). */}
                  {i > 0 && <div aria-hidden className="h-px bg-divider lg:ml-[8.375rem]" />}
                  <div className="py-8">
                    <ChangelogEntryView
                      entry={entry}
                      mediaUrls={media}
                      base={base}
                      lang={lang}
                      language={language}
                      dateMargin
                      excerpt
                      eager={i === 0}
                      react={{ projectSlug: slug, signedIn: !!session }}
                    />
                  </div>
                </div>
              ))}
            </div>
          )}
          {(older || page > 1) && (
            // Wrapping onto two lines where both don't fit (a phone in a language with long words); Older stays at the end.
            <nav aria-label={t("pages")} className="flex flex-wrap justify-between gap-4 border-t pt-8 lg:ml-[8.375rem]">
              {page > 1 ? (
                <Link href={at(changelogPath(page - 1, tag))} className={buttonVariants({ variant: "outline", className: "font-semibold" })}>
                  <ArrowLeftIcon aria-hidden /> {t("newer")}
                </Link>
              ) : (
                <span />
              )}
              {older && (
                <Link href={at(changelogPath(page + 1, tag))} className={buttonVariants({ variant: "outline", className: "ml-auto font-semibold" })}>
                  {t("older")} <ArrowRightIcon aria-hidden />
                </Link>
              )}
            </nav>
          )}
          {/* Below wide screens, where a reader who gets it stands (the form is in Subscribe's popover). */}
          {subscribe && !subscribable && <div className="lg:hidden">{subscribe}</div>}
        </div>
      </div>
    </div>
  );
}
