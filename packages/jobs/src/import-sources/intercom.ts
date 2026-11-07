import type { FeaturebaseAdmin, FeaturebaseArticle, FeaturebaseCollection, FeaturebaseContact, Page } from "../featurebase";
import { intercom, type IntercomAdmin, type IntercomArticle, type IntercomCollection, type IntercomContact, IntercomError, type IntercomPages } from "../intercom";
import type { ImportSourceDefinition } from "./index";

/** Unix seconds as an ISO date. */
const isoOf = (seconds: number | null | undefined) => (seconds ? new Date(seconds * 1000).toISOString() : null);
/** The last part of a help center page's address (`1234-billing`), Featurebase's slug's shape. */
const slugOf = (url: string | null | undefined) => {
  try {
    return url ? (new URL(url).pathname.split("/").filter(Boolean).at(-1) ?? null) : null;
  } catch {
    return null;
  }
};
const idOf = (id: string | number | null | undefined) => (id === null || id === undefined || id === "" ? null : String(id));
/** A numbered list's next page (null: it was the last). */
const nextPage = (pages: IntercomPages | undefined, page: number) => ((pages?.total_pages ?? 0) > page ? String(page + 1) : null);

/** Companies' names read at once, for a page of contacts. */
const COMPANIES_AT_ONCE = 10;
/** Whole passes over the articles at most, after the first, when articles were deleted as it read them. */
const MAX_FULL_PASSES = 3;
/**
 * How far back a pass after the first looks, before the pass it follows began (seconds): Intercom stamps its answer
 * after it read the list, and an edit can take a moment to reach the list, so one edited just before is looked at too.
 */
const EDIT_MARGIN = 60;

/**
 * Where a read of the articles list got to (its cursor, as JSON). Intercom lists them newest updated first, by page
 * number, so the list moves as it's read: one edited moves to the front (to a page already read, and would be missed),
 * one deleted moves those after it up a place (the first of the next page to the page before). So once a pass ends,
 * another reads from the front only what was updated since it began (by Intercom's clock, with EDIT_MARGIN), and again
 * until a pass finds nothing edited after it began itself (what it read from before then, the pass before had in view); one that saw articles deleted (the count fell) reads the whole list again instead. What comes twice is
 * skipped by the import, as a repeated page is.
 */
type ArticlesCursor = {
  /** The page to read. */
  page: number;
  /** Only those updated since (Unix seconds); 0: the whole list. */
  since: number;
  /** The list's count as this pass read its first page, and when it began: by Intercom's clock, and the earliest of it and this machine's. */
  count: number;
  began: number;
  from: number;
  /** This pass found articles edited after it began: there may be more it didn't see. */
  brought: boolean;
  /** This pass saw articles deleted. */
  shrank: boolean;
  /** Whole passes after the first. */
  passes: number;
};

/** Intercom's generic picture for someone without one (…/default-avatars/…): left out, so Tuti draws its own. */
const photo = (url: string | null | undefined) => (url && !/\/default-avatars?\//.test(url) ? url : null);

const admin = (a: IntercomAdmin): FeaturebaseAdmin => ({ id: String(a.id), name: a.name, email: a.email, profilePicture: photo(a.avatar?.image_url) });

const collection = (c: IntercomCollection): FeaturebaseCollection => ({
  id: String(c.id),
  parentId: idOf(c.parent_id),
  name: c.name,
  description: c.description,
  slug: slugOf(c.url),
  order: c.order,
  createdAt: isoOf(c.created_at),
});

const article = (a: IntercomArticle): FeaturebaseArticle => ({
  id: String(a.id),
  parentId: idOf(a.parent_id) ?? idOf(a.parent_ids?.[0]),
  title: a.title,
  description: a.description,
  body: a.body,
  slug: slugOf(a.url),
  state: a.state === "published" ? "live" : "draft",
  isPublished: a.state === "published",
  // Intercom's API gives only the published version: unpublished changes aren't brought.
  isDraftDiffersFromLive: false,
  visibleBy: !a.help_center_audience || a.help_center_audience === "everyone" ? ["everyone"] : [a.help_center_audience],
  author: a.author_id ? { authorId: String(a.author_id) } : null,
  createdAt: isoOf(a.created_at),
  updatedAt: isoOf(a.updated_at),
});

export const intercomSource: ImportSourceDefinition = {
  name: "Intercom",
  credential: "key",
  status: (error) => (error instanceof IntercomError ? error.status : null),
  connect: (token, { deadline }) => {
    const api = intercom(token, { deadline });
    /** Companies' names by id (null: deleted since), for a page of contacts: each read once, a few at a time. */
    const companyNames = async (ids: string[]) => {
      const names = new Map<string, string | null>();
      const unique = [...new Set(ids)];
      for (let i = 0; i < unique.length; i += COMPANIES_AT_ONCE) {
        const batch = unique.slice(i, i + COMPANIES_AT_ONCE);
        const read = await Promise.all(
          batch.map((id) =>
            api.get<{ name?: string | null }>(`/companies/${encodeURIComponent(id)}`).then(
              (company) => company.name ?? null,
              (error: unknown) => {
                // One deleted since is left out; any other failure fails the page, as a list's would.
                if (error instanceof IntercomError && error.status === 404) {
                  return null;
                }
                throw error;
              },
            ),
          ),
        );
        batch.forEach((id, j) => names.set(id, read[j]!));
      }
      return names;
    };
    const contact = (c: IntercomContact, names: Map<string, string | null>): FeaturebaseContact => {
      const name = names.get(c.companies?.data?.[0]?.id ?? "");
      return {
        id: c.id,
        userId: c.external_id,
        type: c.role === "lead" ? "lead" : "customer",
        email: c.email,
        name: c.name,
        profilePicture: photo(typeof c.avatar === "string" ? c.avatar : c.avatar?.image_url),
        customFields: c.custom_attributes,
        companies: name ? [{ name }] : [],
      };
    };
    /** One page of a numbered help center list (`cursor`: its number; null: the first). */
    const numbered = async <T, R>(path: string, cursor: string | null, perPage: number, map: (item: T) => R): Promise<Page<R>> => {
      const page = Number(cursor ?? 1);
      const body = await api.get<{ data: T[]; pages?: IntercomPages }>(path, { page, per_page: perPage });
      return { items: body.data.map(map), next: nextPage(body.pages, page) };
    };
    return {
      checkCredential: () => api.get("/me"),
      checks: {
        contacts: () => api.get("/contacts", { per_page: 1 }),
        // Articles' authors are its admins.
        docs: () => Promise.all([api.get("/help_center/collections", { per_page: 1 }), api.get("/articles", { per_page: 1 }), api.get("/admins")]),
        // It reads only what's here: nothing to check.
        avatars: async () => undefined,
      },
      read: {
        admins: async () => (await api.get<{ admins: IntercomAdmin[] }>("/admins")).admins.map(admin),
        contacts: async (cursor) => {
          const body = await api.get<{ data: IntercomContact[]; pages?: IntercomPages }>("/contacts", { per_page: 150, starting_after: cursor, escape_identity: "false" });
          const next = typeof body.pages?.next === "object" ? (body.pages.next?.starting_after ?? null) : null;
          // Only the first company is kept (`company`).
          const names = await companyNames(body.data.flatMap((c) => c.companies?.data?.[0]?.id ?? []));
          return { items: body.data.map((c) => contact(c, names)), next: next && next !== cursor ? next : null };
        },
        collections: (cursor) => numbered("/help_center/collections", cursor, 250, collection),
        articles: async (cursor, limit) => {
          const at: ArticlesCursor = cursor ? (JSON.parse(cursor) as ArticlesCursor) : { page: 1, since: 0, count: 0, began: 0, from: 0, brought: false, shrank: false, passes: 0 };
          const before = Math.floor(Date.now() / 1000);
          const body = await api.get<{ data: IntercomArticle[]; total_count?: number; pages?: IntercomPages }>("/articles", { page: at.page, per_page: limit ?? 100 });
          const count = body.total_count ?? 0;
          if (at.page === 1) {
            // Strictly later than the pass before, so passes can't repeat within one second of Intercom's clock.
            const began = Math.max(api.now(), at.began + 1);
            Object.assign(at, { count, began, from: Math.min(before, began), brought: false, shrank: false });
          }
          at.shrank ||= count < at.count;
          const items = at.since ? body.data.filter((a) => (a.updated_at ?? 0) >= at.since) : body.data;
          at.brought ||= items.some((a) => (a.updated_at ?? 0) >= at.began);
          // A pass after the first ends at the first article older than it looks for (or the list's end).
          if (items.length === body.data.length && nextPage(body.pages, at.page)) {
            return { items: items.map(article), next: JSON.stringify({ ...at, page: at.page + 1 }) };
          }
          const next: ArticlesCursor | null =
            at.shrank && at.passes < MAX_FULL_PASSES
              ? { ...at, page: 1, since: 0, passes: at.passes + 1 }
              : at.since === 0 || at.brought
                ? { ...at, page: 1, since: at.from - EDIT_MARGIN }
                : null;
          return { items: items.map(article), next: next && JSON.stringify(next) };
        },
        articleExists: (id) =>
          api.get(`/articles/${encodeURIComponent(id)}`).then(
            () => true,
            (error: unknown) => {
              if (error instanceof IntercomError && error.status === 404) {
                return false;
              }
              throw error;
            },
          ),
      },
    };
  },
};
