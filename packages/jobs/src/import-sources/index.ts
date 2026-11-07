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
import { cannySource } from "./canny";
import { featurebaseSource } from "./featurebase";
import { intercomSource } from "./intercom";
import { ferndeskSource } from "./ferndesk";
import { websiteSource } from "./website";
import { frillSource } from "./frill";
import { noltSource } from "./nolt";

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
  /**
   * A source whose list is only its articles' addresses (a crawled site): an article's text, read when the content pass
   * gets to it, within its time, so one already brought across is never read again. Null: gone or refused (left for
   * the last check, articleExists); throws: failing for a while (the pass stops there, and reads it again next).
   */
  article: (item: FeaturebaseArticle) => Promise<FeaturebaseArticle | null>;
  /** Its unpublished changes. */
  articleDraft: (id: string) => Promise<FeaturebaseArticle | null>;
  articleExists: (id: string) => Promise<boolean>;
  conversations: (cursor: string | null, limit: number) => Promise<Page<FeaturebaseConversation>>;
  conversation: (id: string) => Promise<FeaturebaseConversation | null>;
  /**
   * A source that finds its records by crawling (a help center by address): a step's worth of finding, from where the
   * import's kept state (connect's `state`) left it. The help center's first step runs it until `done`, keeping `state` on
   * the import (`data_import.sourceState`) with each page, so every later step, in whichever worker, reads the same list.
   */
  find: () => Promise<{ state: unknown; done: boolean; progress: string }>;
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
  /**
   * Reading stops past `deadline` (ms since the epoch). `state`: what its `find` kept on the import (none yet, or a
   * check). `projectId`: the project it imports into (none for the start's check).
   */
  connect: (credential: string, options: { deadline: number; state?: unknown; projectId?: string }) => ImportConnection;
  /** A source's error's HTTP status (0: unreachable), null for any other error. */
  status: (error: unknown) => number | null;
  /**
   * What a link in its help center's content points at, by its address's path (and the whole address, `url`, for a
   * source whose ids are addresses): an article or collection (`kind`, or
   * either) by its id or its `ref` (FeaturebaseArticle's), null for neither. Without it, links stay as they are.
   */
  docsLink?: (path: string, url: URL) => { kind?: "article" | "collection"; ref: string } | null;
};

/** Every source, by the import row's `source`: adding one is its enum value, its file and its line here. */
export const IMPORT_SOURCES: Record<ImportSource, ImportSourceDefinition> = {
  FEATUREBASE: featurebaseSource,
  INTERCOM: intercomSource,
  FERNDESK: ferndeskSource,
  CANNY: cannySource,
  WEBSITE: websiteSource,
  FRILL: frillSource,
  NOLT: noltSource,
};
