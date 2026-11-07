import {
  featurebase,
  type FeaturebaseAdmin,
  type FeaturebaseArticle,
  type FeaturebaseBoard,
  type FeaturebaseChangelog,
  type FeaturebaseCollection,
  type FeaturebaseComment,
  type FeaturebaseContact,
  type FeaturebaseConversation,
  FeaturebaseError,
  type FeaturebasePost,
  type FeaturebaseVoter,
} from "../featurebase";
import type { ImportSourceDefinition } from "./index";

/** Null for a record Featurebase no longer has (404). */
const unlessGone = <T>(read: Promise<T>): Promise<T | null> =>
  read.catch((error: unknown) => {
    if (error instanceof FeaturebaseError && error.status === 404) {
      return null;
    }
    throw error;
  });

/**
 * A help center page by its id in its path: /en/articles/1234567-setup (or /articles/…, /en/help/articles/…, Intercom's
 * /<workspace>/en/articles/…, /collections/…), on any host. Featurebase's and Intercom's docsLink.
 */
export function idLink(path: string): { kind: "article" | "collection"; ref: string } | null {
  const [, kind, ref] = /^\/(?:[\w-]+\/){0,2}(articles|collections)\/(\d+)(?:-|\/|$)/.exec(path) ?? [];
  return ref ? { kind: kind === "articles" ? "article" : "collection", ref } : null;
}

const article = (id: string) => `/help_center/articles/${encodeURIComponent(id)}`;

export const featurebaseSource: ImportSourceDefinition = {
  name: "Featurebase",
  credential: "key",
  status: (error) => (error instanceof FeaturebaseError ? error.status : null),
  docsLink: idLink,
  connect: (key, { deadline }) => {
    const api = featurebase(key, { deadline });
    return {
      checkCredential: () => api.get("/admins"),
      checks: {
        team: () => api.get("/admins"),
        contacts: () => api.get("/contacts", { limit: 1, contactType: "all" }),
        feedback: () => Promise.all([api.get("/boards"), api.get("/posts", { limit: 1 })]),
        changelog: () => api.get("/changelogs", { limit: 1, state: "all" }),
        docs: () => Promise.all([api.get("/help_center/help_centers", { limit: 1 }), api.get("/help_center/articles", { limit: 1, state: "all" })]),
        inbox: () => api.get("/conversations", { limit: 1 }),
        // It reads only what's here: nothing to check.
        avatars: async () => undefined,
      },
      read: {
        admins: async () => (await api.get<{ data: FeaturebaseAdmin[] }>("/admins")).data,
        contacts: (cursor) => api.page<FeaturebaseContact>("/contacts", cursor, { contactType: "all" }),
        contact: (id) => unlessGone(api.get<FeaturebaseContact>(`/contacts/${encodeURIComponent(id)}`)),
        boards: () => api.get<FeaturebaseBoard[]>("/boards"),
        posts: (cursor) => api.page<FeaturebasePost>("/posts", cursor, { sortBy: "createdAt", sortOrder: "asc" }),
        voters: (postId, cursor) => unlessGone(api.page<FeaturebaseVoter>(`/posts/${encodeURIComponent(postId)}/voters`, cursor)),
        comments: (cursor) => api.page<FeaturebaseComment>("/comments", cursor, { privacy: "all", sortBy: "old" }),
        changelog: (cursor, limit) => api.page<FeaturebaseChangelog>("/changelogs", cursor, { state: "all", sortBy: "date", sortOrder: "asc", limit }),
        collections: (cursor) => api.page<FeaturebaseCollection>("/help_center/collections", cursor),
        articles: (cursor, limit) => api.page<FeaturebaseArticle>("/help_center/articles", cursor, { state: "all", ...(limit && { limit }) }),
        articleDraft: (id) => unlessGone(api.get<FeaturebaseArticle>(article(id), { state: "draft" })),
        // Its draft (every article has one; a never-published one only that), else its live version: gone only on a 404 for both.
        articleExists: async (id) => (await unlessGone(api.get(article(id), { state: "draft" }))) !== null || (await unlessGone(api.get(article(id)))) !== null,
        conversations: (cursor, limit) => api.page<FeaturebaseConversation>("/conversations", cursor, { limit }),
        conversation: (id) => unlessGone(api.get<FeaturebaseConversation>(`/conversations/${encodeURIComponent(id)}`)),
      },
    };
  },
};
