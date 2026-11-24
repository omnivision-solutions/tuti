import { prisma } from "@tuti/db";

import type { FeaturebaseAdmin, FeaturebaseArticle, FeaturebaseChangelog, FeaturebaseCollection, FeaturebaseContact, FeaturebaseConversation, FeaturebasePart, Page } from "../featurebase";
import {
  type FerndeskArticle,
  type FerndeskChangelog,
  type FerndeskCollection,
  type FerndeskConversation,
  type FerndeskCustomer,
  type FerndeskDraft,
  type FerndeskEntry,
  FerndeskError,
  type FerndeskMessage,
  type FerndeskSection,
  type FerndeskTeammate,
  type FerndeskTicket,
  type FerndeskUser,
  ferndesk,
} from "../ferndesk";
import type { ImportSourceDefinition } from "./index";

/**
 * Ferndesk (docs/plan.md, Import from Ferndesk): its help center, its changelogs, the people who signed in to it, its
 * helpdesk's conversations and its AI assistant's, mapped into Featurebase's shapes. Its API has no team, no authors, no order for collections and
 * articles (they come by name, as Tuti sorts ties) and no article descriptions or visibility.
 */

/** Null for a record Ferndesk no longer has, or a helpdesk the workspace hasn't turned on (404: none of its conversations). */
const unlessGone = <T>(read: Promise<T>): Promise<T | null> => unless([404], read);

/** Null for an answer of one of these statuses. */
const unless = <T>(statuses: number[], read: Promise<T>): Promise<T | null> =>
  read.catch((error: unknown) => {
    if (error instanceof FerndeskError && statuses.includes(error.status)) {
      return null;
    }
    throw error;
  });


const article = (id: string) => `/articles/${encodeURIComponent(id)}`;
/** The short id ending a public address's last segment (`…/paying-by-card-pq7rs`). */
const shortIdOf = (path: string) => /-([A-Za-z0-9]{4,12})\/?$/.exec(path)?.[1] ?? null;
const pathOf = (url: string | null) => {
  try {
    return url ? new URL(url).pathname : "";
  } catch {
    return "";
  }
};
const html = (text: string) =>
  text
    .split(/\n+/)
    .map((line) => `<p>${line.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")}</p>`)
    .join("");

/**
 * Where an article or collection goes: its collection, else (with more than one section) its section, which comes as a
 * top-level collection; a help center of one section is its collections themselves. `sections`: the help center's,
 * without its changelogs', and whether they come as collections (`tops`, helpCenter). One in no section is in the
 * default one.
 */
function parentOf(item: { sectionId: string | null }, parent: string | null, { sections, tops }: { sections: FerndeskSection[]; tops: boolean }) {
  const section = item.sectionId ?? sections.find((s) => s.isDefault)?.id;
  return parent ?? (tops && sections.some((s) => s.id === section) ? section! : null);
}

/** When an entry is dated: when it went live on the day it shows, else that day, else when it went live or was made. */
const entryDate = (e: FerndeskEntry) => (e.date && !e.publishedAt?.startsWith(e.date) ? e.date : (e.publishedAt ?? e.date ?? e.createdAt));

/** A published entry's live text; a draft's is its draft's (its live one is empty until it's first published). */
function entryOf(e: FerndeskEntry): FeaturebaseChangelog {
  const live = e.status === "published";
  return {
    id: e.id,
    title: live ? e.title : (e.draft?.title ?? e.title),
    content: live ? e.contentHtml : (e.draft?.contentHtml ?? e.contentHtml),
    date: entryDate(e),
    state: live ? "live" : "draft",
    // Its tags (new, improved, fixed) as the categories Tuti's tags are read from.
    categories: (e.tags ?? []).map((tag) => ({ id: tag, name: tag })),
    createdAt: e.createdAt,
    updatedAt: e.updatedAt,
  };
}

/** One who never proved their address (`emailVerified`) is a lead: their address is never matched to someone here's. */
const contactOf = (user: FerndeskUser): FeaturebaseContact => ({ id: user.id, type: user.emailVerified ? "customer" : "lead", email: user.email, name: user.name, customFields: user.attributes });

/**
 * A conversation with the AI assistant, closed (it's history, not the team's to answer). Its turns have no times of
 * their own: each a second after the one before from its start, so they keep their order and a later import adds only
 * turns after them.
 */
function conversationOf(c: FerndeskConversation): FeaturebaseConversation {
  const person = c.user ? { id: c.user.id, type: "customer", name: c.user.name } : { type: "visitor" };
  return {
    id: c.id,
    // Not Ferndesk's summary, written for the team: the person sees the subject. Their first turn is it (saveConversation).
    title: null,
    state: "closed",
    // Who they are (customer or lead) is the contact's own, read with it.
    participants: c.user ? [{ id: c.user.id, type: "customer" }] : [],
    source: { channel: "widget" },
    createdAt: c.createdAt,
    updatedAt: c.updatedAt,
    lastActivityAt: c.updatedAt,
    conversationParts: (c.transcript ?? []).map((turn, i) => ({
      id: `${c.id}:${i}`,
      partType: turn.role === "user" ? "user_msg" : "bot_msg",
      createdAt: new Date(Date.parse(c.createdAt) + i * 1000).toISOString(),
      bodyHtml: html(turn.text),
      author: turn.role === "user" ? person : { type: "bot" },
    })),
  };
}

/**
 * The helpdesk's conversations go by their Ferndesk id with this before it, the AI assistant's by theirs alone (as
 * imports before the helpdesk recorded them): both are `conv_…` there. A list cursor with it is the helpdesk's; the
 * helpdesk's list comes first, then the assistant's (a cursor without it, ASSISTANT for its first page).
 */
const HELPDESK = "helpdesk:";
const ASSISTANT = "assistant:";

/** One who wrote to the helpdesk is a lead: an address typed into a chat, or an email's sender, proves nothing. */
const customerOf = (c: FerndeskCustomer): FeaturebaseContact => ({ id: c.id, type: "lead", email: c.email, name: c.name, customFields: c.properties });

/**
 * A helpdesk timeline entry as a conversation part. A reply that hasn't reached the customer (cancelled, failed, held,
 * still queued) isn't one, nor is a system event: the team's message would say they were answered.
 */
function partOf(m: FerndeskMessage, ticket: FerndeskTicket): FeaturebasePart[] {
  const who = m.author.type;
  const author =
    who === "customer" ? { id: m.author.id ?? ticket.customer?.id ?? null, type: "lead", name: m.author.name } : who === "teammate" ? { id: m.author.id, type: "admin", name: m.author.name } : { type: "bot" };
  const partType = m.type === "note" ? (who === "teammate" || who === "ai_agent" ? "admin_note" : null) : m.type !== "message" || (m.delivery && !["sent", "delivered"].includes(m.delivery.status)) ? null : who === "customer" ? "user_msg" : who === "teammate" ? "admin_msg" : who === "ai_agent" ? "bot_msg" : null;
  if (!partType) {
    return [];
  }
  return [
    {
      id: m.id,
      partType,
      createdAt: m.created_at,
      bodyHtml: m.body_html ?? html(m.body_text),
      channel: ticket.channel === "email" ? "email" : "chat",
      author,
      // One with no address is left out and counted; its message stays.
      files: m.attachments.map((a) => ({ url: a.url, name: a.filename })),
    },
  ];
}

/** A helpdesk conversation with its timeline: waiting on the customer and open are both open here (the inbox says which by who wrote last). */
const ticketOf = (t: FerndeskTicket, timeline: FerndeskMessage[]): FeaturebaseConversation => ({
  id: HELPDESK + t.id,
  title: t.subject,
  state: t.status === "closed" ? "closed" : t.status === "snoozed" ? "snoozed" : "open",
  snoozedUntil: t.snoozed_until,
  adminAssigneeId: t.assignee?.id ?? null,
  participants: t.customer ? [{ id: t.customer.id, type: "lead" }] : [],
  source: { channel: t.channel === "email" ? "email" : "widget", subject: t.subject },
  createdAt: t.created_at,
  updatedAt: t.updated_at,
  lastActivityAt: t.last_message_at ?? t.updated_at,
  conversationParts: timeline.flatMap((m) => partOf(m, t)),
});

export const ferndeskSource: ImportSourceDefinition = {
  name: "Ferndesk",
  credential: "key",
  status: (error) => (error instanceof FerndeskError ? error.status : null),
  // Its addresses end in the page's short id, on whatever domain the help center is.
  docsLink: (path) => {
    const ref = shortIdOf(path);
    return ref ? { ref } : null;
  },
  connect: (key, { deadline, projectId }) => {
    const api = ferndesk(key, { deadline });
    let sections: Promise<FerndeskSection[]> | undefined;
    const allSections = () => (sections ??= api.all<FerndeskSection>("/sections"));
    let collections: Promise<FerndeskCollection[]> | undefined;
    const allCollections = () => (collections ??= api.all<FerndeskCollection>("/collections"));
    let changelogs: Promise<FerndeskChangelog[]> | undefined;
    const allChangelogs = () => (changelogs ??= api.all<FerndeskChangelog>("/changelogs"));
    /**
     * The help center without its changelogs: Ferndesk lists each changelog as a collection too, its entries as
     * articles, and the section it sits in as any (the Changelog part brings them). A section with nothing else in it,
     * no other collection and no article outside one, is a changelog's own. What's in no section is in the default one.
     * Sections come as top-level collections with more than one, or when an earlier import made one (before changelogs
     * were left out, a changelog's own section counted): what's new goes into the collections it made.
     */
    let help: Promise<{ sections: FerndeskSection[]; tops: boolean; changelogs: Set<string> }> | undefined;
    const helpCenter = () =>
      (help ??= Promise.all([allSections(), allCollections(), allChangelogs()]).then(async ([sections, all, logs]) => {
        const ids = new Set(logs.map((log) => log.id));
        const home = sections.find((s) => s.isDefault)?.id ?? null;
        const shared = (s: FerndeskSection) => !logs.some((log) => (log.sectionId ?? home) === s.id) || all.some((c) => (c.sectionId ?? home) === s.id && !ids.has(c.id));
        const candidates = sections.filter((s) => !shared(s));
        // ponytail: whether one has articles outside a collection takes reading every article, once per connection, so
        // only when there's a section to drop; ask Ferndesk for a section filter if help centers grow to thousands.
        const loose = candidates.length ? new Set((await api.all<FerndeskArticle>("/articles", { status: "all" })).filter((a) => !a.collectionId).map((a) => a.sectionId ?? home)) : new Set();
        const kept = sections.filter((s) => shared(s) || loose.has(s.id));
        const made =
          kept.length === 1 && projectId
            ? await prisma.importedRecord.count({ where: { projectId, source: "FERNDESK", kind: "collection", externalId: { in: kept.map((s) => s.id) } } })
            : 0;
        return { sections: kept, tops: kept.length > 1 || made > 0, changelogs: ids };
      }));
    let entries: Promise<FerndeskEntry[]> | undefined;
    let language: Promise<string> | undefined;
    const defaultLanguage = () => (language ??= api.get<{ default: string }>("/articles/languages").then((body) => body.default));
    const articleOf = (a: FerndeskArticle, layout: { sections: FerndeskSection[]; tops: boolean }): FeaturebaseArticle => ({
      id: a.id,
      parentId: parentOf(a, a.collectionId, layout),
      title: a.title,
      body: a.contentHtml ?? "",
      slug: a.slug,
      ref: shortIdOf(pathOf(a.url)),
      state: a.status === "published" ? "live" : "draft",
      isPublished: a.status === "published",
      // Its drafts are read for each published one: the list doesn't say which have one.
      isDraftDiffersFromLive: a.status === "published",
      createdAt: a.createdAt,
      updatedAt: a.updatedAt,
    });
    return {
      // Every list needs a scope: a key without this one (403) is still a key Ferndesk accepts, and the parts' checks say what it can't read.
      checkCredential: () =>
        api.get("/articles", { page_size: 1 }).catch((error: unknown) => {
          if (!(error instanceof FerndeskError && error.status === 403)) {
            throw error;
          }
        }),
      checks: {
        contacts: () => api.get("/users", { page_size: 1 }),
        // Drafts need a key that can write content (Ferndesk's scopes).
        docs: () =>
          Promise.all([
            api.get("/articles", { page_size: 1, status: "all" }),
            api.get("/collections", { page_size: 1 }),
            api.get("/sections", { page_size: 1 }),
            // To leave the changelogs out.
            api.get("/changelogs", { page_size: 1 }),
          ]),
        // Its drafts need Write content too.
        changelog: async () => {
          const [first] = (await api.get<{ results: FerndeskChangelog[] }>("/changelogs", { page_size: 1 })).results;
          return first && api.get(`/changelogs/${encodeURIComponent(first.id)}/entries`, { page_size: 1, status: "all" });
        },
        // The helpdesk's (Read inbox) and the AI assistant's (Read conversations).
        inbox: () => Promise.all([unlessGone(api.get("/conversations", { limit: 1 })), api.get("/assistant/conversations", { page_size: 1 })]),
      },
      read: {
        // Who works the helpdesk, those removed since too (they wrote its replies and notes); none without a helpdesk
        // (404) or for a key that can't read it (403: only the inbox needs them, and its check asks for Read inbox). Every
        // teammate is on one page (Ferndesk's API reference).
        admins: async () => {
          const teammates = await unless([403, 404], api.get<{ data: FerndeskTeammate[] }>("/teammates", { include_removed: "true" }));
          return (teammates?.data ?? []).map((t): FeaturebaseAdmin => ({ id: t.id, name: t.name, email: t.email, profilePicture: t.avatar_url }));
        },
        contacts: async (cursor) => {
          const { items, next } = await api.page<FerndeskUser>("/users", cursor);
          return { items: items.map(contactOf), next };
        },
        // The helpdesk's customers (cust_…) and the help center's users.
        contact: async (id) => {
          if (id.startsWith("cust_")) {
            const customer = await unlessGone(api.get<FerndeskCustomer>(`/customers/${encodeURIComponent(id)}`));
            return customer && customerOf(customer);
          }
          const user = await unlessGone(api.get<FerndeskUser>(`/users/${encodeURIComponent(id)}`));
          return user && contactOf(user);
        },
        // Sections (with more than one) as top-level collections in their order, then every collection, in one page.
        collections: async () => {
          const [layout, collections] = await Promise.all([helpCenter(), allCollections()]);
          const { sections: all, changelogs: logs } = layout;
          const tops: FeaturebaseCollection[] = layout.tops ? all.map((s) => ({ id: s.id, parentId: null, name: s.name, order: s.position, createdAt: s.createdAt })) : [];
          const rest = collections.filter((c) => !logs.has(c.id)).map(
            (c): FeaturebaseCollection => ({ id: c.id, parentId: parentOf(c, c.parentCollectionId, layout), name: c.title, description: c.subtitle, slug: null, ref: c.shortId, createdAt: c.createdAt }),
          );
          return { items: [...tops, ...rest], next: null };
        },
        articles: async (cursor, limit) => {
          const [{ items, next }, layout] = await Promise.all([
            api.page<FerndeskArticle>("/articles", cursor, { status: "all", format: "html", page_size: limit ?? 100 }),
            helpCenter(),
          ]);
          return { items: items.filter((a) => !a.collectionId || !layout.changelogs.has(a.collectionId)).map((a) => articleOf(a, layout)), next };
        },
        changelog: async (cursor, limit) => {
          // ponytail: Ferndesk lists entries newest first, a changelog at a time, so each connection reads them all and
          // takes its slice oldest first; read them by date range if changelogs grow to thousands.
          const all = await (entries ??= allChangelogs().then(async (logs) =>
            (await Promise.all(logs.map((log) => api.all<FerndeskEntry>(`/changelogs/${encodeURIComponent(log.id)}/entries`, { status: "all", format: "html" }))))
              .flat()
              .sort((a, b) => Date.parse(entryDate(a)) - Date.parse(entryDate(b)) || a.id.localeCompare(b.id)),
          ));
          const from = Number(cursor ?? 0);
          return { items: all.slice(from, from + limit).map(entryOf), next: from + limit < all.length ? String(from + limit) : null };
        },
        // Its open draft in the default language, unless the article was published past it since (stale).
        articleDraft: async (id) => {
          const drafts = await unlessGone(api.get<FerndeskDraft[]>(`${article(id)}/drafts`));
          let open: FerndeskDraft | undefined;
          for (const draft of drafts ?? []) {
            if (!open && draft.status === "open" && !draft.stale && (draft.language === null || draft.language === (await defaultLanguage()))) {
              open = draft;
            }
          }
          if (!open) {
            return null;
          }
          const full = await unlessGone(api.get<FerndeskDraft>(`${article(id)}/drafts/${encodeURIComponent(open.id)}`, { format: "html" }));
          // A draft that keeps the article's title has none of its own.
          const title = full?.title ?? (await unlessGone(api.get<FerndeskArticle>(article(id))))?.title;
          return full && { id, title, body: full.contentHtml ?? "" };
        },
        articleExists: async (id) => (await unlessGone(api.get(article(id)))) !== null,
        // The helpdesk's (spam left out), then the AI assistant's. Each listed without its messages: `conversation` reads them.
        conversations: async (cursor, limit): Promise<Page<FeaturebaseConversation>> => {
          if (!cursor || cursor.startsWith(HELPDESK)) {
            const page = await unlessGone(api.helpdeskPage<FerndeskTicket>("/conversations", cursor?.slice(HELPDESK.length) || null, { limit }));
            return { items: (page?.items ?? []).map((t) => ticketOf(t, [])), next: page?.next ? HELPDESK + page.next : ASSISTANT };
          }
          const { items, next } = await api.page<FerndeskConversation>("/assistant/conversations", cursor === ASSISTANT ? null : cursor, { page_size: limit });
          return { items: items.map(conversationOf), next };
        },
        conversation: async (id) => {
          if (id.startsWith(HELPDESK)) {
            const path = `/conversations/${encodeURIComponent(id.slice(HELPDESK.length))}`;
            const ticket = await unlessGone(api.get<FerndeskTicket>(path));
            if (!ticket) {
              return null;
            }
            const timeline: FerndeskMessage[] = [];
            let cursor: string | null = null;
            do {
              const next: Page<FerndeskMessage> = await api.helpdeskPage<FerndeskMessage>(`${path}/messages`, cursor);
              timeline.push(...next.items);
              cursor = next.next;
            } while (cursor);
            return ticketOf(ticket, timeline);
          }
          const c = await unlessGone(api.get<FerndeskConversation>(`/assistant/conversations/${encodeURIComponent(id)}`));
          return c && conversationOf(c);
        },
      },
    };
  },
};
