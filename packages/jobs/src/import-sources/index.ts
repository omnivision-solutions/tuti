import type { ImportSource } from "@tuti/db";

import type {
  FeaturebaseAdmin,
  FeaturebaseArticle,
  FeaturebaseBoard,
  FeaturebaseChangelog,
  FeaturebaseCollection,
  FeaturebaseComment,
  FeaturebaseContact,
  FeaturebaseConversation,
  FeaturebasePost,
  FeaturebaseVoter,
  Page,
} from "../featurebase";
import { featurebaseSource } from "./featurebase";

/**
 * How the import's part jobs read a source (packages/jobs/src/import-*.ts): each a page at a time (`cursor` null: the
 * first) or one record, null for one the source no longer has. Records are in Featurebase's shapes, the first source's:
 * another source maps its own into them, and the part jobs bring them into Tuti as they do Featurebase's. A source has
 * the readers its parts use (the part jobs assert them): feedback, docs and inbox also read `admins` (who wrote it), and
 * feedback and inbox `contact` (people the contacts' list missed).
 */
export type ImportReaders = Partial<{
  admins: () => Promise<FeaturebaseAdmin[]>;
  contacts: (cursor: string | null) => Promise<Page<FeaturebaseContact>>;
  contact: (id: string) => Promise<FeaturebaseContact | null>;
  boards: () => Promise<FeaturebaseBoard[]>;
  /** Oldest first. */
  posts: (cursor: string | null) => Promise<Page<FeaturebasePost>>;
  /** Null: the post is gone. */
  voters: (postId: string, cursor: string | null) => Promise<Page<FeaturebaseVoter> | null>;
  /** Oldest first, private ones too. */
  comments: (cursor: string | null) => Promise<Page<FeaturebaseComment>>;
  /** Oldest first, drafts too. */
  changelog: (cursor: string | null, limit: number) => Promise<Page<FeaturebaseChangelog>>;
  collections: (cursor: string | null) => Promise<Page<FeaturebaseCollection>>;
  /** Drafts too. */
  articles: (cursor: string | null, limit?: number) => Promise<Page<FeaturebaseArticle>>;
  /** Its unpublished changes. */
  articleDraft: (id: string) => Promise<FeaturebaseArticle | null>;
  articleExists: (id: string) => Promise<boolean>;
  conversations: (cursor: string | null, limit: number) => Promise<Page<FeaturebaseConversation>>;
  conversation: (id: string) => Promise<FeaturebaseConversation | null>;
}>;

/** The parts an import can bring (IMPORT_PARTS' names). */
export type ImportPart = "team" | "contacts" | "feedback" | "changelog" | "docs" | "inbox" | "avatars";

/** A source connected with its credential: its key checked, each part's list checked, and read. */
export type ImportConnection = {
  /** Fails when the source refuses the credential. */
  checkCredential: () => Promise<unknown>;
  /** The parts it can bring (@tuti/jobs IMPORT_PARTS' names), each with how a credential is checked for it (its list read once). */
  checks: Partial<Record<ImportPart, () => Promise<unknown>>>;
  read: ImportReaders;
};

/** A tool an import brings from (docs/plan.md, Switching from Featurebase). */
export type ImportSourceDefinition = {
  /** As the team's messages say it. */
  name: string;
  /** What the team gives it: an API key, or the address of a public site. */
  credential: "key" | "url";
  /** Reading stops past `deadline` (ms since the epoch). */
  connect: (credential: string, options: { deadline: number }) => ImportConnection;
  /** A source's error's HTTP status (0: unreachable), null for any other error. */
  status: (error: unknown) => number | null;
};

/** Every source, by the import row's `source`: adding one is its enum value, its file and its line here. */
export const IMPORT_SOURCES: Record<ImportSource, ImportSourceDefinition> = {
  FEATUREBASE: featurebaseSource,
};
