import type { FeaturebaseArticle, FeaturebaseChangelog, FeaturebaseCollection, FeaturebaseContact, FeaturebaseConversation } from "../featurebase";
import {
  type FerndeskArticle,
  type FerndeskChangelog,
  type FerndeskCollection,
  type FerndeskConversation,
  type FerndeskDraft,
  type FerndeskEntry,
  FerndeskError,
  type FerndeskSection,
  type FerndeskUser,
  ferndesk,
} from "../ferndesk";
import type { ImportSourceDefinition } from "./index";

/**
 * Ferndesk (docs/plan.md, Import from Ferndesk): its help center, its changelogs, the people who signed in to it, and
 * its AI assistant's conversations, mapped into Featurebase's shapes. Its API has no team, no authors, no order for collections and
 * articles (they come by name, as Tuti sorts ties) and no article descriptions or visibility.
 */

/** Null for a record Ferndesk no longer has (404). */
const unlessGone = <T>(read: Promise<T>): Promise<T | null> =>
  read.catch((error: unknown) => {
    if (error instanceof FerndeskError && error.status === 404) {
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
 * without its changelogs' (helpCenter).
 */
const parentOf = (item: { sectionId: string | null }, parent: string | null, sections: FerndeskSection[]) =>
  parent ?? (sections.length > 1 && sections.some((s) => s.id === item.sectionId) ? item.sectionId : null);

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

export const ferndeskSource: ImportSourceDefinition = {
  name: "Ferndesk",
  credential: "key",
  status: (error) => (error instanceof FerndeskError ? error.status : null),
  // Its addresses end in the page's short id, on whatever domain the help center is.
  docsLink: (path) => {
    const ref = shortIdOf(path);
    return ref ? { ref } : null;
  },
  connect: (key, { deadline }) => {
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
     * no other collection and no article outside one, is a changelog's own.
     */
    let help: Promise<{ sections: FerndeskSection[]; changelogs: Set<string> }> | undefined;
    const helpCenter = () =>
      (help ??= Promise.all([allSections(), allCollections(), allChangelogs()]).then(async ([sections, all, logs]) => {
        const ids = new Set(logs.map((log) => log.id));
        const shared = (s: FerndeskSection) => !logs.some((log) => log.sectionId === s.id) || all.some((c) => c.sectionId === s.id && !ids.has(c.id));
        const candidates = sections.filter((s) => !shared(s));
        // ponytail: whether one has articles outside a collection takes reading every article, once per connection, so
        // only when there's a section to drop; ask Ferndesk for a section filter if help centers grow to thousands.
        const loose = candidates.length ? new Set((await api.all<FerndeskArticle>("/articles", { status: "all" })).filter((a) => !a.collectionId).map((a) => a.sectionId)) : new Set();
        return { sections: sections.filter((s) => shared(s) || loose.has(s.id)), changelogs: ids };
      }));
    let entries: Promise<FerndeskEntry[]> | undefined;
    let language: Promise<string> | undefined;
    const defaultLanguage = () => (language ??= api.get<{ default: string }>("/articles/languages").then((body) => body.default));
    const articleOf = (a: FerndeskArticle, all: FerndeskSection[]): FeaturebaseArticle => ({
      id: a.id,
      parentId: parentOf(a, a.collectionId, all),
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
        inbox: () => api.get("/assistant/conversations", { page_size: 1 }),
      },
      read: {
        admins: async () => [],
        contacts: async (cursor) => {
          const { items, next } = await api.page<FerndeskUser>("/users", cursor);
          return { items: items.map(contactOf), next };
        },
        contact: async (id) => {
          const user = await unlessGone(api.get<FerndeskUser>(`/users/${encodeURIComponent(id)}`));
          return user && contactOf(user);
        },
        // Sections (with more than one) as top-level collections in their order, then every collection, in one page.
        collections: async () => {
          const [{ sections: all, changelogs: logs }, collections] = await Promise.all([helpCenter(), allCollections()]);
          const tops: FeaturebaseCollection[] = all.length > 1 ? all.map((s) => ({ id: s.id, parentId: null, name: s.name, order: s.position, createdAt: s.createdAt })) : [];
          const rest = collections.filter((c) => !logs.has(c.id)).map(
            (c): FeaturebaseCollection => ({ id: c.id, parentId: parentOf(c, c.parentCollectionId, all), name: c.title, description: c.subtitle, slug: null, ref: c.shortId, createdAt: c.createdAt }),
          );
          return { items: [...tops, ...rest], next: null };
        },
        articles: async (cursor, limit) => {
          const [{ items, next }, { sections: all, changelogs: logs }] = await Promise.all([
            api.page<FerndeskArticle>("/articles", cursor, { status: "all", format: "html", page_size: limit ?? 100 }),
            helpCenter(),
          ]);
          return { items: items.filter((a) => !a.collectionId || !logs.has(a.collectionId)).map((a) => articleOf(a, all)), next };
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
        conversations: async (cursor, limit) => {
          const { items, next } = await api.page<FerndeskConversation>("/assistant/conversations", cursor, { page_size: limit });
          return { items: items.map(conversationOf), next };
        },
        conversation: async (id) => {
          const c = await unlessGone(api.get<FerndeskConversation>(`/assistant/conversations/${encodeURIComponent(id)}`));
          return c && conversationOf(c);
        },
      },
    };
  },
};
