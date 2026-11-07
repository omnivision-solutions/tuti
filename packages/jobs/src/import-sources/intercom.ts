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

const admin = (a: IntercomAdmin): FeaturebaseAdmin => ({ id: String(a.id), name: a.name, email: a.email, profilePicture: a.avatar?.image_url ?? null });

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
    /** Companies' names by id, read once each for the connection: a contact lists only its companies' ids. */
    const companies = new Map<string, Promise<string | null>>();
    const companyName = (id: string) => {
      if (!companies.has(id)) {
        companies.set(
          id,
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
        );
      }
      return companies.get(id)!;
    };
    const contact = async (c: IntercomContact): Promise<FeaturebaseContact> => {
      const company = c.companies?.data?.[0]?.id;
      const name = company ? await companyName(company) : null;
      return {
        id: c.id,
        userId: c.external_id,
        type: c.role === "lead" ? "lead" : "customer",
        email: c.email,
        name: c.name,
        profilePicture: typeof c.avatar === "string" ? c.avatar : (c.avatar?.image_url ?? null),
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
          const items: FeaturebaseContact[] = [];
          for (const c of body.data) {
            items.push(await contact(c));
          }
          return { items, next: next && next !== cursor ? next : null };
        },
        collections: (cursor) => numbered("/help_center/collections", cursor, 250, collection),
        articles: (cursor, limit) => numbered("/articles", cursor, limit ?? 100, article),
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
