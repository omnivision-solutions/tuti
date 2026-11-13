import { billingFile } from "@tuti/testkit";
import { prisma } from "@tuti/db";
import { isValidElement, type ReactNode } from "react";
import { beforeEach, expect, test, vi } from "vitest";

import { ChangelogSeen } from "@/components/changelog-seen";
import { ChangelogSubscribe } from "@/components/changelog-subscribe";
import { actAs, createProject, signUp } from "@/test/helpers";

import ChangelogPage from "./page";
import OlderChangelogPage from "./page/[page]/page";
import ChangelogEntryPage from "./[number]/page";

/** The changelog a page at a time: /changelog, then /changelog/page/2 and on. */

let project: Awaited<ReturnType<typeof createProject>>;

beforeEach(async () => {
  project = await createProject(await signUp());
  actAs(null);
  // 45 entries: two full pages of 20, and 5 on the third.
  await prisma.changelogEntry.createMany({
    data: Array.from({ length: 45 }, (_, i) => ({
      projectId: project.id,
      number: i + 1,
      title: `Entry ${i + 1}`,
      publishedAt: new Date(Date.UTC(2026, 0, 1, 0, i + 1)),
    })),
  });
});

/**
 * A page's entries (first and last number) and where its links go ("Newer entries", "Older entries", the tags' chips),
 * the month index's ("January 2026, 45 entries"), and `seen`, up to when it marks a signed-in reader's announcements seen;
 * or "308 <where>", "404". `tag`: `?tag=`.
 */
async function changelog(page?: string, tag?: string) {
  const params = Promise.resolve({ project: project.slug, ...(page !== undefined && { page }) });
  const searchParams = Promise.resolve(tag === undefined ? {} : { tag });
  const props = { params, searchParams } as never;
  const rendered = await (page === undefined ? ChangelogPage(props) : OlderChangelogPage(props)).then(
    (node) => node as ReactNode,
    (error: { digest?: string }) => {
      const redirect = error.digest?.match(/^NEXT_REDIRECT;\w+;([^;]+);(\d+);/);
      return redirect ? `${redirect[2]} ${redirect[1]}` : error.digest === "NEXT_HTTP_ERROR_FALLBACK;404" ? "404" : Promise.reject(error);
    },
  );
  if (typeof rendered === "string") {
    return rendered;
  }
  const entries: number[] = [];
  const links: Record<string, string> = {};
  const months: Record<string, string> = {};
  let seen: string | undefined;
  const walk = (node: ReactNode): void => {
    if (Array.isArray(node)) {
      node.forEach(walk);
    } else if (isValidElement<{ children?: ReactNode; action?: ReactNode; entry?: { number: number }; href?: string; "aria-label"?: string }>(node)) {
      if (node.props.entry) {
        entries.push(node.props.entry.number);
      }
      if (node.type === ChangelogSeen) {
        seen = (node.props as { at: string }).at;
      }
      // A row of pills (the tags': FilterPills), its links given as items.
      for (const item of (node.props as { items?: { title: ReactNode; href: string }[] }).items ?? []) {
        if (typeof item.title === "string") {
          links[item.title] = item.href;
        }
      }
      if (node.props.href && node.props["aria-label"]) {
        months[node.props["aria-label"]] = node.props.href;
      } else if (node.props.href && node.type !== "a") {
        // A link between its pages (not the RSS feed's plain <a>): its words, beside any icon ("Older entries →").
        const children = [node.props.children].flat();
        if (children.some((child) => typeof child === "string")) {
          links[children.filter((child) => typeof child === "string").join("").trim()] = node.props.href;
        }
      }
      walk(node.props.children);
      // An empty state's button; the page header's tag pills.
      walk(node.props.action);
      walk((node.props as { pills?: ReactNode }).pills);
    }
  };
  walk(rendered);
  return { entries: entries.length ? `${entries[0]}–${entries.at(-1)}` : "none", ...links, ...(Object.keys(months).length > 0 && { months }), ...(seen && { seen }) };
}

test("older entries are at /changelog/page/<n>; the links between pages follow", async () => {
  expect(await changelog()).toEqual({
    entries: "45–26",
    "Older entries": "/changelog/page/2",
    months: { "January 2026, 45 entries": "/changelog#2026-01" },
  });
  expect(await changelog("2")).toEqual(
    expect.objectContaining({ entries: "25–6", "Newer entries": "/changelog", "Older entries": "/changelog/page/3" }),
  );
  expect(await changelog("3")).toEqual(expect.objectContaining({ entries: "5–1", "Newer entries": "/changelog/page/2" }));
});

test("page 1 is /changelog; past the last page, or not a page number, it's a 404", async () => {
  expect(await changelog("1")).toBe("308 /changelog");
  for (const page of ["4", "0", "02", "-1", "2.5", "two", "99999"]) {
    expect(await changelog(page)).toBe("404");
  }
});

test("a tag's chip lists only its entries, `?tag=` kept through the pages; the month index jumps to each month's page", async () => {
  // Newer than the 45 untagged January ones: 22 fixes in February, 3 in March, then something new in April.
  const at = (month: number, day: number) => new Date(Date.UTC(2026, month, day));
  await prisma.changelogEntry.createMany({
    data: [
      ...Array.from({ length: 25 }, (_, i) => ({ number: 46 + i, tags: ["FIXED" as const], publishedAt: i < 22 ? at(1, i + 1) : at(2, i - 21) })),
      { number: 71, tags: ["NEW" as const], publishedAt: at(3, 1) },
    ].map((entry) => ({ ...entry, projectId: project.id, title: `Entry ${entry.number}` })),
  });
  // An unpublished entry's tag gets no chip.
  await prisma.changelogEntry.create({ data: { projectId: project.id, number: 72, title: "Draft", tags: ["BREAKING"] } });

  const chips = { All: "/changelog", New: "/changelog?tag=new", Fixed: "/changelog?tag=fixed" };
  expect(await changelog()).toEqual({
    entries: "71–52",
    ...chips,
    "Older entries": "/changelog/page/2",
    months: {
      "April 2026, 1 entry": "/changelog#2026-04",
      "March 2026, 3 entries": "/changelog#2026-03",
      "February 2026, 22 entries": "/changelog#2026-02",
      "January 2026, 45 entries": "/changelog/page/2#2026-01",
    },
  });
  expect(await changelog(undefined, "fixed")).toEqual({
    entries: "70–51",
    ...chips,
    "Older entries": "/changelog/page/2?tag=fixed",
    months: { "March 2026, 3 entries": "/changelog?tag=fixed#2026-03", "February 2026, 22 entries": "/changelog?tag=fixed#2026-02" },
  });
  expect(await changelog("2", "fixed")).toEqual({
    entries: "50–46",
    ...chips,
    "Newer entries": "/changelog?tag=fixed",
    months: { "March 2026, 3 entries": "/changelog?tag=fixed#2026-03", "February 2026, 22 entries": "/changelog?tag=fixed#2026-02" },
  });
  expect(await changelog("1", "fixed")).toBe("308 /changelog?tag=fixed");
  expect(await changelog("3", "fixed")).toBe("404");
  // A tag no entry has: nothing, and a way back to all of them; a short list has no month index.
  expect(await changelog(undefined, "improved")).toEqual({ entries: "none", ...chips, "Show all entries": "/changelog" });
  expect(await changelog(undefined, "new")).toEqual({ entries: "71–71", ...chips });
  // Not a tag: every entry.
  expect(await changelog(undefined, "bogus")).toEqual(expect.objectContaining({ entries: "71–52", "Older entries": "/changelog/page/2" }));
});

test("signed in, the first page marks the latest announcement seen; a tag's page or an older one only when it shows that entry", async () => {
  const publishedAt = new Date();
  await prisma.changelogEntry.create({
    data: { projectId: project.id, number: 46, title: "Dark mode", tags: ["NEW"], announced: true, publishedAt },
  });
  // An older fix, so the Fixed tag has a page without the announcement.
  await prisma.changelogEntry.update({ where: { projectId_number: { projectId: project.id, number: 45 } }, data: { tags: ["FIXED"] } });
  actAs(await signUp());
  const seen = publishedAt.toISOString();
  expect(await changelog()).toEqual(expect.objectContaining({ entries: "46–27", seen }));
  expect(await changelog(undefined, "new")).toEqual(expect.objectContaining({ entries: "46–46", seen }));
  const fixes = await changelog(undefined, "fixed");
  expect(fixes).toEqual(expect.objectContaining({ entries: "45–45" }));
  expect(fixes).not.toHaveProperty("seen");
  expect(await changelog("2")).not.toHaveProperty("seen");
});

test("the first page marks the latest announcement seen even when quieter entries since push it to page 2", async () => {
  const announcedAt = new Date(Date.now() - 60 * 60 * 1000);
  await prisma.changelogEntry.create({
    data: { projectId: project.id, number: 46, title: "Dark mode", announced: true, publishedAt: announcedAt },
  });
  // 20 published since without announcing them: a page of them.
  await prisma.changelogEntry.createMany({
    data: Array.from({ length: 20 }, (_, i) => ({
      projectId: project.id,
      number: 47 + i,
      title: `Fix ${i + 1}`,
      publishedAt: new Date(announcedAt.getTime() + (i + 1) * 1000),
    })),
  });
  actAs(await signUp());
  expect(await changelog()).toEqual(expect.objectContaining({ entries: "66–47", seen: announcedAt.toISOString() }));
  expect(await changelog("2")).toEqual(expect.objectContaining({ entries: "46–27", seen: announcedAt.toISOString() }));
});

test("two announcements published together: a tag's page showing only the earlier-numbered one doesn't mark the latest seen", async () => {
  // Seen is kept as a time, so marking this one's time would clear the other, which the reader didn't see.
  const publishedAt = new Date();
  await prisma.changelogEntry.createMany({
    data: [
      { projectId: project.id, number: 46, title: "Dark mode", tags: ["NEW"], announced: true, publishedAt },
      { projectId: project.id, number: 47, title: "Faster search", tags: ["FIXED"], announced: true, publishedAt },
    ],
  });
  actAs(await signUp());
  const onlyNew = await changelog(undefined, "new");
  expect(onlyNew).toEqual(expect.objectContaining({ entries: "46–46" }));
  expect(onlyNew).not.toHaveProperty("seen");
  expect(await changelog(undefined, "fixed")).toEqual(expect.objectContaining({ entries: "47–47", seen: publishedAt.toISOString() }));
});

/**
 * The changelog's email box: "form" (Get updates by email), or the line said instead, its link as "[text](href)". On the
 * list, or with `entry` on that entry's own page.
 */
async function emailBox(entry?: number) {
  const props = {
    params: Promise.resolve({ project: project.slug, ...(entry && { number: String(entry) }) }),
    searchParams: Promise.resolve({}),
  } as never;
  const text = (node: ReactNode): string =>
    Array.isArray(node)
      ? node.map(text).join("")
      : isValidElement<{ children?: ReactNode; href?: string }>(node)
        ? node.props.href ? `[${text(node.props.children)}](${node.props.href})` : text(node.props.children)
        : typeof node === "string" || typeof node === "number" ? String(node) : "";
  let box: string | undefined;
  const walk = (node: ReactNode): void => {
    if (Array.isArray(node)) {
      node.forEach(walk);
    } else if (isValidElement<{ children?: ReactNode }>(node)) {
      if (node.type === ChangelogSubscribe) {
        box = "form";
      } else if (node.type === "p" && text(node).includes("(/account)")) {
        box = text(node);
      } else {
        walk(node.props.children);
      }
    }
  };
  walk((await (entry ? ChangelogEntryPage(props) : ChangelogPage(props))) as ReactNode);
  return box;
}

test("an entry's own page ends with getting the changelog by email: the form signed out, where a subscriber stands", async () => {
  expect(await emailBox(1)).toBe("form");
  const reader = await signUp("Reader");
  await prisma.user.update({ where: { id: reader.id }, data: { emailVerified: true } });
  const email = reader.email.toLowerCase();
  await prisma.changelogSubscriber.create({ data: { projectId: project.id, email, confirmedAt: new Date() } });
  actAs(reader);
  expect(await emailBox(1)).toBe(`The changelog entries ${project.name} emails to subscribers go to ${email}. [Manage](/account)`);
});

test("the email box agrees with the reader's Account: the form signed out or not getting it; once they do, or turned emails off, where they stand", async () => {
  expect(await emailBox()).toBe("form");
  const reader = await signUp("Reader");
  await prisma.user.update({ where: { id: reader.id }, data: { emailVerified: true } });
  actAs(reader);
  expect(await emailBox()).toBe("form");
  // Subscribed but not confirmed yet: nothing is sent, so still the form (as Account's switch is off).
  const email = reader.email.toLowerCase();
  await prisma.changelogSubscriber.create({ data: { projectId: project.id, email } });
  expect(await emailBox()).toBe("form");
  await prisma.changelogSubscriber.update({ where: { projectId_email: { projectId: project.id, email } }, data: { confirmedAt: new Date() } });
  expect(await emailBox()).toBe(`The changelog entries ${project.name} emails to subscribers go to ${email}. [Manage](/account)`);
  // The project's email paused (where projects are paused at all): it goes once they're resumed, as Account's switch stays on.
  vi.stubEnv("BILLING_CONFIG", billingFile());
  await prisma.project.update({ where: { id: project.id }, data: { emailPausedAt: new Date() } });
  expect(await emailBox()).toBe(
    `The changelog entries ${project.name} emails to subscribers go to ${email} once ${project.name}'s emails, paused for now, are resumed. [Manage](/account)`,
  );
  vi.unstubAllEnvs();
  await prisma.project.update({ where: { id: project.id }, data: { emailPausedAt: null } });
  // All of the project's emails turned off: that wins, said as the subscription pages say it.
  await prisma.emailOptOut.create({ data: { projectId: project.id, userId: reader.id } });
  expect(await emailBox()).toBe(`You've turned off all of ${project.name}'s emails, so its changelog isn't emailed to ${email} either. [Manage](/account)`);
  // Only to whoever proved the address is theirs: unproven, the form.
  await prisma.user.update({ where: { id: reader.id }, data: { emailVerified: false } });
  expect(await emailBox()).toBe("form");
  // Another account's opt-out at their address (one the project's sign-on gives it) isn't theirs to undo: the form.
  await prisma.user.update({ where: { id: reader.id }, data: { emailVerified: true } });
  await prisma.emailOptOut.deleteMany({ where: { userId: reader.id } });
  const other = await signUp("Other");
  await prisma.ssoIdentity.create({ data: { projectId: project.id, externalId: "user-1", userId: other.id, email } });
  await prisma.emailOptOut.create({ data: { projectId: project.id, userId: other.id } });
  expect(await emailBox()).toBe("form");
});
