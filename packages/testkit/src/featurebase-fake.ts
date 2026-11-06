import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

/** The API key the fake accepts; any other is refused (401), as Featurebase refuses a bad one. */
export const FAKE_FEATUREBASE_KEY = "sk_fake_featurebase";
/**
 * A key the fake also takes whose pages of a list (100 at a time, as an import reads; not a start's checks) wait until
 * `release()` (or a POST to `<url>/_fake/release`, for journeys in other processes): an import that's running for as long
 * as a test needs. Held ones go on after a minute regardless, so nothing hangs.
 */
export const FAKE_FEATUREBASE_SLOW_KEY = "sk_fake_featurebase_slow";

type Row = Record<string, unknown>;

/** What the fake serves, made up. Imports of more parts add theirs (boards, posts, articles, conversations, …). */
export type FeaturebaseFixtures = {
  contacts: (Row | null)[];
  admins: Row[];
  boards: Row[];
  posts: Row[];
  comments: Row[];
  voters: Record<string, Row[]>;
  helpCenters: Row[];
  collections: Row[];
  /** Live versions (or a draft's only one), as GET /v2/help_center/articles?state=all lists them. */
  articles: Row[];
  /** Articles' drafts with changes not published (GET /v2/help_center/articles/{id}?state=draft), by id. */
  articleDrafts: Row[];
  conversations: Row[];
  /** Changelog entries, live and drafts, as GET /v2/changelogs?state=all lists them (oldest first). */
  changelogs: Row[];
};

/**
 * Where the fixtures' images are: the fake serves its files (`file`, and FAKE_FEATUREBASE_FILES' own) at this address,
 * written into what it sends as its own `<url>/files/`.
 */
export const FAKE_FEATUREBASE_FILES = "https://files.featurebase-fake.invalid/";
/** A small green PNG (96×64), for the fixtures' images and avatar. */
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAGAAAABACAIAAABqVuVZAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAaUlEQVR42u3QMQ0AAAgDsInDE55QiQNujiZV0NQ0hygQJEiQIEGCBAlCkCBBggQJEiQIQYIECRIkSJAgBAkSJEiQIEGCBCFIkCBBggQJEoQgQYIECRIkSBCCBAkSJEiQIEGCECRIkKB/Flv/efAam8K1AAAAAElFTkSuQmCC",
  "base64",
);

const DAY_MS = 86_400_000;
/** An ISO date `days` ago, `minutes` on. */
const ago = (days: number, minutes = 0) => new Date(Date.now() - days * DAY_MS + minutes * 60_000).toISOString();
const part = (id: string, partType: string, createdAt: string, rest: Row = {}) => ({ object: "conversation_part", id, partType, createdAt, updatedAt: createdAt, ...rest });
const contact = (id: string, name: string, email: string | null) => ({ id, type: "customer", name, email, profilePicture: null });
const admin = (id: string, name: string) => ({ id, type: "admin", name, profilePicture: null });

/**
 * Made-up conversations, newest first as Featurebase lists them: one open where the user wrote last (assigned to the
 * owner, read up to the team's reply, a note, an image), one snoozed after the team's unread reply by email (assigned
 * to the former admin), one closed lately with the bot (and every kind of part that isn't a message), and one closed
 * two years ago.
 */
const conversationFixtures = (): Row[] => {
  const mira = contact("65f000000000000000000001", "Mira Fenwick", "e2e-mira@example.com");
  const tobias = contact("65f000000000000000000002", "Tobias Quill", "e2e-tobias@example.com");
  const juno = { ...contact("65f000000000000000000003", "Juno Park", null), type: "lead" };
  const olive = admin("65f0000000000000000000a1", "Olive Owner");
  const fern = admin("65f0000000000000000000a2", "Fern Former");
  const row = (id: string, rest: Row) => ({ object: "conversation", id, priority: false, teamAssigneeId: null, snoozedUntil: null, tags: [], ...rest });
  return [
    row("1004", {
      title: "Exporting to CSV",
      state: "open",
      adminAssigneeId: olive.id,
      participants: [{ id: mira.id, type: "customer" }],
      source: { channel: "desktop", deliveredAs: "customer_initiated", bodyHtml: "<p>Can I export my data to CSV?</p>", author: { id: mira.id, type: "customer" } },
      createdAt: ago(2),
      updatedAt: ago(1),
      lastActivityAt: ago(1),
      waitingSince: ago(1),
      readReceipts: [
        { id: mira.id, userType: "customer", lastReadPartId: "p1003" },
        { id: olive.id, userType: "admin", lastReadPartId: "p1005" },
      ],
      conversationParts: [
        part("p1001", "user_msg", ago(2, 0.02), { bodyHtml: "<p>Can I export my data to CSV?</p>", bodyMarkdown: "Can I export my data to CSV?", channel: "desktop", author: mira, redacted: false }),
        part("p1002", "assign", ago(2, 1), { adminAssigneeId: olive.id, adminAssignerId: olive.id, teamAssigneeId: null }),
        part("p1003", "admin_msg", ago(2, 5), {
          bodyHtml: '<p>Yes: Settings → Export. See <a href="https://docs.example.com/export">the guide</a>.</p>',
          bodyMarkdown: "Yes: Settings → Export. See [the guide](https://docs.example.com/export).",
          channel: "desktop",
          author: olive,
          redacted: null,
        }),
        part("p1004", "admin_note", ago(2, 6), { bodyHtml: "<p>They're on the pro plan.</p>", bodyMarkdown: "They're on the pro plan.", author: olive, redacted: false }),
        part("p1005", "user_msg", ago(1), {
          bodyHtml: `<p>Here's what I see:</p><p><img src="${FAKE_FEATUREBASE_FILES}shot.png?X-Amz-Expires=3600&amp;X-Amz-Signature=abc" alt="Export screen" width="8" height="8"></p>`,
          bodyMarkdown: "Here's what I see:\n\n![Export screen]( =8x8)",
          channel: "desktop",
          author: mira,
          redacted: false,
        }),
      ],
    }),
    row("1003", {
      state: "snoozed",
      snoozedUntil: ago(-7),
      adminAssigneeId: fern.id,
      participants: [{ id: tobias.id, type: "customer" }],
      source: { channel: "email", deliveredAs: "customer_initiated", subject: "Invoice for October", bodyHtml: "<p>Could you send October's invoice again?</p>", author: { id: tobias.id, type: "customer" } },
      createdAt: ago(3),
      updatedAt: ago(3, 31),
      lastActivityAt: ago(3, 31),
      waitingSince: null,
      readReceipts: [{ id: tobias.id, userType: "customer", lastReadPartId: "p2001" }],
      conversationParts: [
        part("p2001", "email_msg", ago(3, 0.02), { bodyHtml: "<p>Could you send October's invoice again?</p>", bodyMarkdown: "Could you send October's invoice again?", channel: "email", author: tobias, redacted: false }),
        part("p2002", "admin_msg", ago(3, 30), { bodyHtml: "<p>Sent again: it's in your inbox.</p>", bodyMarkdown: "Sent again: it's in your inbox.", channel: "email", author: fern, redacted: false }),
        part("p2003", "status", ago(3, 31), { status: "snoozed", snoozedUntil: ago(-7) }),
      ],
    }),
    row("1002", {
      state: "closed",
      adminAssigneeId: null,
      participants: [{ id: juno.id, type: "lead" }],
      source: { channel: "desktop", deliveredAs: "customer_initiated", bodyHtml: "<p>How do I reset my password?</p><p>It says the link expired.</p>", author: { id: juno.id, type: "lead" } },
      createdAt: ago(10),
      updatedAt: ago(10, 9),
      lastActivityAt: ago(10, 9),
      waitingSince: null,
      readReceipts: [],
      conversationParts: [
        part("p3001", "user_msg", ago(10, 0.02), { bodyHtml: "<p>How do I reset my password?</p><p>It says the link expired.</p>", channel: "desktop", author: juno, redacted: false }),
        part("p3002", "bot_msg", ago(10, 1), {
          bodyHtml: "<p>Use <strong>Forgot password</strong> on the sign-in page:</p><ol><li><p>Open sign in</p></li><li><p>Ask for a new link</p></li></ol>",
          author: { id: null, type: "bot", profilePicture: null },
          redacted: false,
        }),
        part("p3003", "quick_reply_opts", ago(10, 2), { replyOptions: [{ id: "yes", text: "That helped" }] }),
        part("p3004", "quick_reply_resp", ago(10, 3), { bodyHtml: "<p>That helped</p>", selectedOptionId: "yes", author: juno }),
        part("p3005", "rating_requested", ago(10, 4)),
        part("p3006", "rating_submitted", ago(10, 4)),
        part("p3007", "workflow_wait", ago(10, 5), { workflowWait: { eventType: "wait", workflowId: "w1", workflowName: "Bot", occurredAt: ago(10, 5) } }),
        part("p3008", "attr_prompt", ago(10, 6)),
        part("p3009", "attr_complete", ago(10, 6)),
        part("p3010", "priority", ago(10, 7)),
        part("p3011", "part_add", ago(10, 7), { participant: { id: juno.id, type: "lead" } }),
        part("p3012", "tags", ago(10, 8), { action: "added", tagId: "t1", occurredAt: ago(10, 8) }),
        part("p3013", "status", ago(10, 9), { status: "closed", snoozedUntil: null }),
      ],
    }),
    row("1001", {
      title: "Dark mode?",
      state: "closed",
      adminAssigneeId: olive.id,
      participants: [{ id: mira.id, type: "customer" }],
      source: { channel: "desktop", deliveredAs: "customer_initiated", bodyHtml: "<p>Is there a dark mode?</p>", author: { id: mira.id, type: "customer" } },
      createdAt: ago(800),
      updatedAt: ago(790),
      lastActivityAt: ago(790),
      waitingSince: null,
      readReceipts: [],
      conversationParts: [
        part("p4001", "user_msg", ago(800, 0.02), { bodyHtml: "<p>Is there a dark mode?</p>", channel: "desktop", author: mira, redacted: false }),
        part("p4002", "admin_msg", ago(800, 10), { bodyHtml: "<p>Not yet.</p>", channel: "desktop", author: olive, redacted: false }),
      ],
    }),
  ];
};

const article = (row: Row): Row => ({
  object: "article",
  helpCenterId: "hc0000000000fake",
  state: "live",
  isPublished: true,
  isDraftDiffersFromLive: false,
  visibleBy: ["everyone"],
  locale: "en",
  availableLocales: ["en"],
  icon: null,
  createdAt: "2024-03-01T09:00:00.000Z",
  updatedAt: "2024-03-02T09:00:00.000Z",
  ...row,
});

/**
 * Made-up data. Contacts: one with everything (properties of each kind, two companies, an uploaded avatar), one with Featurebase's placeholder avatar, a lead with no email or id of their own, and an empty row (Featurebase sends some).
 * Admins; a help center, its articles' images and files at FAKE_FEATUREBASE_FILES; and conversations (conversationFixtures).
 */
export const featurebaseFixtures = (): FeaturebaseFixtures => ({
  contacts: [
    {
      object: "contact",
      id: "65f000000000000000000001",
      userId: "app-user-1",
      type: "customer",
      name: "Mira Fenwick",
      email: "e2e-mira@example.com",
      profilePicture: `${FAKE_FEATUREBASE_FILES}mira.png`,
      customFields: { plan: "pro", seats: 12, beta: true, features: ["sso", "audit"], nested: { no: true }, notes: "x".repeat(201) },
      companies: [{ object: "company", id: "65f0000000000000000000c1", name: "Fenwick Labs" }, { object: "company", id: "65f0000000000000000000c2", name: "Side Gig" }],
    },
    {
      object: "contact",
      id: "65f000000000000000000002",
      userId: "app-user-2",
      type: "customer",
      name: "Tobias Quill",
      email: "e2e-tobias@example.com",
      profilePicture: "https://global.featurebase-attachments.com/a/shapes/3_200_200.png",
      // A company sent as a custom field, without Featurebase's companies.
      customFields: { plan: "free", company: "Globex" },
      companies: [],
    },
    null,
    { object: "contact", id: "65f000000000000000000003", type: "lead", name: "Juno Park", email: null, profilePicture: null, customFields: {}, companies: [] },
  ],
  admins: [
    { object: "admin", id: "65f0000000000000000000a1", name: "Olive Owner", email: "e2e-featurebase-owner@example.com", profilePicture: null, roleId: "owner" },
    { object: "admin", id: "65f0000000000000000000a2", name: "Fern Former", email: "e2e-featurebase-former@example.com", profilePicture: null, roleId: "admin" },
  ],
  ...feedbackFixtures(),
  // A help center: two collections at the top (one with one inside it), and articles: one with formatting, an image,
  // a document and a link to another later in the order; that one, published with a draft that differs; a draft; and
  // one only some people could see.
  helpCenters: [{ object: "help_center", id: "hc0000000000fake", defaultLocale: "en", locale: "en", availableLocales: ["en"], isPublic: true, title: "Acme Help" }],
  collections: [
    { object: "collection", id: "0100003", parentId: "0100002", name: "Invoices", description: "Finding and paying them.", slug: "0100003-invoices", order: 0, icon: null },
    { object: "collection", id: "0100001", parentId: null, name: "Getting started", description: "Your first steps.", slug: "0100001-getting-started", order: 0, icon: { type: "predefined", value: "LightBulbIcon" } },
    { object: "collection", id: "0100002", parentId: null, name: "Billing", description: "Plans and payments.", slug: "0100002-billing", order: 1, icon: { type: "predefined", value: "MenuAlt2Icon" } },
  ].map((row) => ({ helpCenterId: "hc0000000000fake", createdAt: "2024-02-01T09:00:00.000Z", ...row })),
  articles: [
    article({
      id: "0200001",
      parentId: "0100001",
      order: 0,
      title: "Welcome to Acme",
      description: "What Acme does, in a minute.",
      slug: "0200001-welcome-to-acme",
      author: { authorId: "65f0000000000000000000a1", name: "Olive Owner" },
      body: [
        '<h1 id="x" data-toc-id="x">Start here</h1>',
        '<p class="copied">Acme keeps <strong>every invoice</strong> in one place.</p>',
        "<ul><li><p>Add your team</p></li><li><p>Connect your bank</p></li></ul>",
        `<img src="${FAKE_FEATUREBASE_FILES}welcome.png?X-Amz-Expires=3600&X-Amz-Signature=abc" alt="The dashboard" data-width="100%" data-align="left">`,
        `<p>Then read <a class="link" href="https://help.acme.example/en/articles/0200002-paying-by-card">Paying by card</a>, or browse <a href="/en/collections/0100002-billing">Billing</a>.</p>`,
        `<file-preview-component src="${FAKE_FEATUREBASE_FILES}setup-guide.pdf" data-featurebase-content-filename="setup-guide.pdf"></file-preview-component>`,
      ].join(""),
    }),
    article({
      id: "0200002",
      parentId: "0100003",
      order: 0,
      title: "Paying by card",
      description: "",
      slug: "0200002-paying-by-card",
      isDraftDiffersFromLive: true,
      author: { authorId: "65f0000000000000000000a2", name: "Fern Former" },
      body: '<p>Cards are charged on the 1st. See <a href="https://help.acme.example/en/articles/0200001-welcome-to-acme">Welcome to Acme</a>.</p>',
    }),
    article({
      id: "0200003",
      parentId: "0100001",
      order: 1,
      title: "Roadmap notes",
      slug: "0200003-roadmap-notes",
      state: "draft",
      isPublished: false,
      isDraftDiffersFromLive: true,
      author: { authorId: "65f0000000000000000000a1", name: "Olive Owner" },
      body: "<p>Not ready yet.</p>",
    }),
    article({
      id: "0200004",
      parentId: null,
      order: 0,
      title: "Single sign-on for Enterprise",
      slug: "0200004-single-sign-on-for-enterprise",
      visibleBy: ["65f00000000000000000ee01"],
      author: null,
      body: "<p>Only for Enterprise customers.</p>",
    }),
  ],
  articleDrafts: [
    article({
      id: "0200002",
      state: "draft",
      isPublished: true,
      title: "Paying by card",
      body: "<p>Cards are charged on the 1st. Amex is coming soon.</p>",
    }),
  ],
  conversations: conversationFixtures(),
  changelogs: changelogFixtures(),
});

const MIRA = { id: "65f000000000000000000001", name: "Mira Fenwick", email: "e2e-mira@example.com", profilePicture: null, type: "customer" };
const TOBIAS = { id: "65f000000000000000000002", name: "Tobias Quill", email: "e2e-tobias@example.com", profilePicture: null, type: "customer" };
const JUNO = { id: "65f000000000000000000003", name: "Juno Park", email: null, profilePicture: null, type: "lead" };
const OLIVE = { id: "65f0000000000000000000a1", name: "Olive Owner", email: "e2e-featurebase-owner@example.com", profilePicture: null, type: "admin" };
const FERN = { id: "65f0000000000000000000a2", name: "Fern Former", email: "e2e-featurebase-former@example.com", profilePicture: null, type: "admin" };
const ANOTHER_VISITOR = { id: "65f0000000000000000000g2", name: "Another visitor", email: null, profilePicture: null, type: "guest" };
const OPEN_ACCESS = { adminOnly: false, allowedRoles: [], deniedRoles: [], segments: [] };
const board = (id: string, name: string, access: Row = {}, words: Row = {}) => ({
  object: "board",
  id,
  name,
  createdAt: "2023-05-01T09:00:00.000Z",
  access: { ...OPEN_ACCESS, ...access },
  localization: { name: { en: name }, description: null, heroTitle: null, heroDescription: null, formPlaceholder: null, submitButtonText: null, ...words },
  postDefaults: { visibility: "public" },
});
const status = (name: string, type: string) => ({ object: "post_status", id: `status-${type}`, name, color: "Blue", isDefault: false, type });
const post = (id: string, boardId: string, title: string, author: Row | null, createdAt: string, rest: Row = {}) => ({
  object: "post",
  id,
  title,
  content: `<p>${title}, please.</p>`,
  boardId,
  status: status("In Review", "reviewing"),
  author,
  createdAt,
  updatedAt: createdAt,
  eta: null,
  upvotes: 1,
  commentCount: 0,
  inReview: false,
  portalHidden: false,
  access: { userIds: [], companyExternalIds: [] },
  ...rest,
});
const comment = (id: string, postId: string | null, author: Row, content: string, createdAt: string, rest: Row = {}) => ({
  object: "comment",
  id,
  postId,
  changelogId: postId ? null : "65f0000000000000000000e1",
  parentCommentId: null,
  content,
  author: { ...author, email: undefined },
  createdAt,
  updatedAt: createdAt,
  isPrivate: false,
  inReview: false,
  isSpam: false,
  isDeleted: false,
  ...rest,
});
const voter = (person: Row, createdAt: string) => ({ object: "contact", ...person, createdAt });

/**
 * Made-up feedback: five boards (one with the new project's board's name and its own words, one only admins see, one
 * for a segment, one some roles can't see); posts in date order with statuses by name and by type, an ETA, an image, an admin's and a guest's,
 * and four left out (on a hidden board, waiting for moderation, hidden from the portal, for one person); their voters
 * (the author among them, as Featurebase counts them, a guest author too; a voter made after the post; an admin; a guest); and comments:
 * a public one with an image, a reply, the team's private one, a user's private one, and ones left out (spam,
 * deleted, waiting for moderation, on a left-out post), and a changelog's.
 */
function feedbackFixtures(): Pick<FeaturebaseFixtures, "boards" | "posts" | "comments" | "voters"> {
  return {
    boards: [
      board("65f0000000000000000000b1", "Feature requests", {}, { description: { en: "Ideas for the product" }, formPlaceholder: { en: "What would help you most?" }, submitButtonText: { en: "Share an idea" } }),
      board("65f0000000000000000000b2", "Bugs"),
      board("65f0000000000000000000b3", "Internal", { adminOnly: true }),
      board("65f0000000000000000000b4", "Beta testers", { segments: ["65f0000000000000000000s1"] }),
      board("65f0000000000000000000b6", "Paid plans", { deniedRoles: ["65f0000000000000000000r1"] }),
    ],
    posts: [
      post("65f0000000000000000000p1", "65f0000000000000000000b1", "Dark mode", MIRA, "2024-01-10T08:00:00.000Z", {
        content: `<h1>Dark mode</h1><p>Night owls need it.</p><img src="${FAKE_FEATUREBASE_FILES}whiteboard.png?X-Amz-Signature=abc" alt="A sketch">`,
        status: status("Planned", "unstarted"),
        eta: "2024-06-15T00:00:00.000Z",
        upvotes: 4,
        commentCount: 2,
      }),
      post("65f0000000000000000000p2", "65f0000000000000000000b2", "Export fails on Safari", FERN, "2024-02-01T10:00:00.000Z", { status: status("Fixing", "active"), upvotes: 2 }),
      post("65f0000000000000000000p3", "65f0000000000000000000b3", "Quarterly planning", OLIVE, "2024-02-02T10:00:00.000Z"),
      post("65f0000000000000000000p4", "65f0000000000000000000b1", "Waiting for a moderator", TOBIAS, "2024-02-03T10:00:00.000Z", { inReview: true }),
      post("65f0000000000000000000p5", "65f0000000000000000000b1", "Hidden from the portal", TOBIAS, "2024-02-04T10:00:00.000Z", { portalHidden: true }),
      post("65f0000000000000000000p6", "65f0000000000000000000b2", "Only for one customer", TOBIAS, "2024-02-05T10:00:00.000Z", { access: { userIds: [TOBIAS.id], companyExternalIds: [] } }),
      post("65f0000000000000000000p7", "65f0000000000000000000b4", "Beta feature", JUNO, "2024-02-06T10:00:00.000Z"),
      post("65f0000000000000000000p8", "65f0000000000000000000b2", "Sync with calendars", JUNO, "2024-03-01T10:00:00.000Z", { status: status("Rejected", "canceled") }),
      post("65f0000000000000000000p9", "65f0000000000000000000b1", "Keyboard shortcuts", { id: null, name: "Visitor", email: null, profilePicture: null, type: "guest" }, "2024-03-05T10:00:00.000Z"),
      post("65f0000000000000000000pb", "65f0000000000000000000b1", "Export to PDF", ANOTHER_VISITOR, "2024-03-06T10:00:00.000Z"),
    ],
    voters: {
      "65f0000000000000000000p1": [
        voter(MIRA, "2023-06-01T00:00:00.000Z"),
        voter(TOBIAS, "2024-02-20T12:00:00.000Z"),
        voter(OLIVE, "2023-01-01T00:00:00.000Z"),
        voter({ id: "65f0000000000000000000g1", name: "Guest", email: null, profilePicture: null, type: "guest" }, "2024-01-11T00:00:00.000Z"),
      ],
      "65f0000000000000000000p2": [voter(FERN, "2023-01-01T00:00:00.000Z"), voter(JUNO, "2023-07-01T00:00:00.000Z")],
      "65f0000000000000000000p3": [voter(OLIVE, "2023-01-01T00:00:00.000Z")],
      "65f0000000000000000000p8": [voter(JUNO, "2023-07-01T00:00:00.000Z")],
      // A guest among their own post's voters, as Featurebase counts the author.
      "65f0000000000000000000pb": [voter(ANOTHER_VISITOR, "2024-03-06T10:00:00.000Z")],
    },
    comments: [
      comment("65f0000000000000000000c1", "65f0000000000000000000p1", TOBIAS, `<p>Yes please!</p><img src="${FAKE_FEATUREBASE_FILES}whiteboard.png">`, "2024-01-11T09:00:00.000Z"),
      comment("65f0000000000000000000c2", "65f0000000000000000000p1", OLIVE, "<p>Planning it for June.</p>", "2024-01-12T09:00:00.000Z", { isPrivate: true }),
      comment("65f0000000000000000000c3", "65f0000000000000000000p1", MIRA, "<p>Just between us: we'd pay for it.</p>", "2024-01-13T09:00:00.000Z", { isPrivate: true }),
      comment("65f0000000000000000000c4", "65f0000000000000000000p1", FERN, "<p>On our list, thanks!</p>", "2024-01-14T09:00:00.000Z", { parentCommentId: "65f0000000000000000000c1" }),
      comment("65f0000000000000000000c5", "65f0000000000000000000p2", TOBIAS, "<p>Buy cheap watches</p>", "2024-02-02T09:00:00.000Z", { isSpam: true }),
      comment("65f0000000000000000000c6", "65f0000000000000000000p2", TOBIAS, "<p>Never mind</p>", "2024-02-03T09:00:00.000Z", { isDeleted: true }),
      comment("65f0000000000000000000c7", "65f0000000000000000000p2", JUNO, "<p>Same here</p>", "2024-02-04T09:00:00.000Z", { inReview: true }),
      comment("65f0000000000000000000c8", "65f0000000000000000000p3", OLIVE, "<p>For next quarter</p>", "2024-02-05T09:00:00.000Z"),
      comment("65f0000000000000000000c9", null, TOBIAS, "<p>Nice update</p>", "2024-02-06T09:00:00.000Z"),
      comment("65f0000000000000000000ca", "65f0000000000000000000p8", JUNO, "<p>Still waiting.</p>", "2024-03-02T09:00:00.000Z"),
    ],
  };
}

const changelog = (row: Row): Row => ({
  object: "changelog",
  content: "",
  featuredImage: null,
  state: "live",
  allowedSegmentIds: [],
  categories: [],
  emailSentToSubscribers: false,
  commentCount: 0,
  createdAt: row.date,
  updatedAt: row.date,
  ...row,
});

/**
 * The changelog, newest first as Featurebase lists it by default: an entry with a cover, an image, a category and
 * comments, emailed to subscribers; one improved; a draft that was emailed before it was unpublished; one only a segment
 * sees, one in a category only some roles see; one too long for Tuti.
 */
function changelogFixtures(): Row[] {
  return [
    changelog({
      id: "65f0000000000000000000d6",
      title: "The long one",
      content: `<p>${"word ".repeat(4001)}</p><p><img src="${FAKE_FEATUREBASE_FILES}whiteboard.png"></p>`,
      featuredImage: `${FAKE_FEATUREBASE_FILES}mira.png`,
      date: "2024-03-20T09:00:00.000Z",
    }),
    changelog({ id: "65f0000000000000000000d5", title: "For admins", content: "<p>Roles only.</p>", date: "2024-03-15T09:00:00.000Z", categories: [{ id: "c3", name: "New", roles: ["admin"] }] }),
    changelog({ id: "65f0000000000000000000d4", title: "For our beta group", content: "<p>Just for you.</p>", date: "2024-03-10T09:00:00.000Z", allowedSegmentIds: ["s1"] }),
    changelog({ id: "65f0000000000000000000d3", title: "Single sign-on", content: "<p>Coming soon.</p>", date: "2024-03-05T09:00:00.000Z", state: "draft", emailSentToSubscribers: true }),
    changelog({ id: "65f0000000000000000000d2", title: "Faster exports", content: "<p>Exports take half the time.</p>", date: "2024-03-01T09:00:00.000Z", categories: [{ id: "c2", name: "Improvement" }] }),
    changelog({
      id: "65f0000000000000000000d1",
      title: "Dark mode is here",
      content: `<p>Easy on the eyes at night.</p><p><img src="${FAKE_FEATUREBASE_FILES}shot.png" alt="Dark mode"></p>`,
      featuredImage: `${FAKE_FEATUREBASE_FILES}welcome.png`,
      date: "2024-02-01T09:00:00.000Z",
      categories: [{ id: "c1", name: "New" }],
      emailSentToSubscribers: true,
      commentCount: 2,
    }),
  ];
}

/**
 * Lists the fake serves, by path: paged ones as Featurebase pages them; unpaged ones (admins) in one; bare ones (boards)
 * as an array. `detail`: fields only one item's own GET has (a conversation's parts).
 */
const LISTS: Record<string, { fixtures: Exclude<keyof FeaturebaseFixtures, "voters">; paged: boolean; bare?: true; detail?: string[] }> = {
  "/v2/contacts": { fixtures: "contacts", paged: true },
  "/v2/admins": { fixtures: "admins", paged: false },
  "/v2/boards": { fixtures: "boards", paged: false, bare: true },
  "/v2/posts": { fixtures: "posts", paged: true },
  "/v2/comments": { fixtures: "comments", paged: true },
  "/v2/help_center/help_centers": { fixtures: "helpCenters", paged: true },
  "/v2/help_center/collections": { fixtures: "collections", paged: true },
  "/v2/help_center/articles": { fixtures: "articles", paged: true },
  "/v2/conversations": { fixtures: "conversations", paged: true, detail: ["conversationParts"] },
  "/v2/changelogs": { fixtures: "changelogs", paged: true },
};
const VOTERS = /^\/v2\/posts\/([^/]+)\/voters$/;

export type FeaturebaseFake = {
  url: string;
  env: { FEATUREBASE_API_URL: string };
  /** What it serves; change it freely. */
  fixtures: FeaturebaseFixtures;
  /** A page holds at most this many (Featurebase: 100), so a few fixtures make several pages. */
  pageSize: number;
  /** Called as a file is asked for, before it's answered (an import copying media has started). */
  onFile?: (name: string) => void;
  /** Requests made, as `GET /v2/contacts?limit=100&…`. */
  requests: string[];
  /** Lists answered 403 with their items (e.g. "/v2/contacts"; posts' voters as "/v2/posts/voters"), as for a key that can't read them. */
  forbidden: Set<string>;
  /**
   * The next `times` API requests answer `status` (e.g. 429, 500), with these response headers (Retry-After,
   * X-RateLimit-Reset) and `body` as it is (default an error's JSON): a 200 with a cut-off body, an empty page. With
   * `path`, only requests to a path it matches fail (the others answer as usual).
   */
  failNext(status: number, times?: number, headers?: Record<string, string>, body?: string, path?: RegExp): void;
  /** Runs between a failing answer's headers and its body (sent a moment later): time passing as the body is read. */
  beforeBody?: () => void;
  /** Lets the slow key's held pages answer (FAKE_FEATUREBASE_SLOW_KEY), and those that come later too. */
  release(): void;
  /** Serves a file at `<url>/files/<name>` (no key, like Featurebase's attachments' links); returns its address. */
  file(name: string, type: string, body: Buffer): string;
  close(): Promise<void>;
};

/** A local stand-in for Featurebase's API (v2): it checks the key and serves fixtures, paged with opaque cursors. */
export async function startFeaturebaseFake(): Promise<FeaturebaseFake> {
  const files = new Map<string, { type: string; body: Buffer }>([
    ["whiteboard.png", { type: "image/png", body: PNG }],
    ["mira.png", { type: "image/png", body: PNG }],
    ["shot.png", { type: "image/png", body: PNG }],
    ["welcome.png", { type: "image/png", body: PNG }],
    ["setup-guide.pdf", { type: "application/pdf", body: Buffer.from("%PDF-1.4\n%invented test file\n") }],
  ]);
  let failing: { status: number; times: number; headers: Record<string, string>; body?: string; path?: RegExp } | undefined;
  /** The slow key's held pages, each with its fallback timer. */
  const held = new Map<() => void, NodeJS.Timeout>();
  /** Once released, the slow key's pages answer at once: one that arrives after the release isn't held. */
  let released = false;

  const server = createServer((req, res) => {
    const send = (status: number, body: unknown) =>
      res.writeHead(status, { "Content-Type": "application/json" }).end(JSON.stringify(body).replaceAll(FAKE_FEATUREBASE_FILES, `${fake.url}/files/`));
    const url = new URL(req.url ?? "/", "http://fake");
    if (req.method === "GET" && url.pathname.startsWith("/files/")) {
      const file = files.get(decodeURIComponent(url.pathname.slice("/files/".length)));
      fake.onFile?.(decodeURIComponent(url.pathname.slice("/files/".length)));
      return file ? res.writeHead(200, { "Content-Type": file.type }).end(file.body) : send(404, { message: "no such file" });
    }
    if (req.method === "POST" && url.pathname === "/_fake/release") {
      fake.release();
      return send(200, { released: true });
    }
    fake.requests.push(`${req.method} ${url.pathname}${url.search}`);
    const slow = req.headers.authorization === `Bearer ${FAKE_FEATUREBASE_SLOW_KEY}`;
    if (req.headers.authorization !== `Bearer ${FAKE_FEATUREBASE_KEY}` && !slow) {
      return send(401, { success: false, message: "Invalid API key" });
    }
    if (slow && !released && url.searchParams.get("limit") === "100" && !req.headers["x-fake-late"]) {
      req.headers["x-fake-late"] = "1";
      fake.requests.pop();
      const go = () => server.emit("request", req, res);
      const timer = setTimeout(() => held.delete(go) && go(), 60_000);
      held.set(go, timer);
      return;
    }
    if (failing && (!failing.path || failing.path.test(url.pathname))) {
      const { status, headers, body } = failing;
      failing = --failing.times > 0 ? failing : undefined;
      const text = body ?? JSON.stringify({ error: { type: "api_error", message: "fake failure", status } });
      res.writeHead(status, { "Content-Type": "application/json", ...headers });
      if (!fake.beforeBody) {
        return res.end(text);
      }
      res.flushHeaders();
      const before = fake.beforeBody;
      setTimeout(() => {
        before();
        res.end(text);
      }, 50);
      return;
    }
    if (req.method !== "GET") {
      return send(405, { message: "the fake is read-only" });
    }
    const voters = VOTERS.exec(url.pathname);
    const list = voters ? { rows: fake.fixtures.voters[decodeURIComponent(voters[1]!)] ?? [], paged: true } : LISTS[url.pathname] && { ...LISTS[url.pathname]!, rows: fake.fixtures[LISTS[url.pathname]!.fixtures] };
    const parent = url.pathname.slice(0, url.pathname.lastIndexOf("/"));
    const path = voters ? "/v2/posts/voters" : list ? url.pathname : parent;
    if (fake.forbidden.has(path)) {
      return send(403, { error: { type: "authorization_error", message: "Your API key can't read this", status: 403 } });
    }
    // A post's voters, for a post it doesn't have (deleted, merged): 404, as Featurebase answers.
    if (voters && !fake.fixtures.posts.some((post) => post.id === decodeURIComponent(voters[1]!))) {
      return send(404, { error: { type: "invalid_request_error", code: "resource_not_found", message: "Post not found", status: 404 } });
    }
    // Articles: the live ones unless `state` says otherwise (all, or draft), as Featurebase lists them.
    const state = url.searchParams.get("state") ?? "live";
    if (list) {
      const detail = "detail" in list ? list.detail : undefined;
      const rows = (list.rows as (Row | null)[])
        .filter((row) => (list.rows !== fake.fixtures.articles && list.rows !== fake.fixtures.changelogs) || state === "all" || row?.state === state)
        .map((row) => (row && detail ? Object.fromEntries(Object.entries(row).filter(([key]) => !detail.includes(key))) : row));
      // Changelog entries by date, newest first unless `sortOrder` says asc, as Featurebase sorts them.
      if (list.rows === fake.fixtures.changelogs) {
        const asc = url.searchParams.get("sortOrder") === "asc";
        rows.sort((a, b) => (asc ? 1 : -1) * String(a?.date).localeCompare(String(b?.date)));
      }
      if (!list.paged) {
        return send(200, "bare" in list ? rows : { object: "list", data: rows, nextCursor: null });
      }
      const limit = Math.min(Number(url.searchParams.get("limit") ?? 10), 100, fake.pageSize);
      const cursor = url.searchParams.get("cursor");
      const start = cursor ? Number(Buffer.from(cursor, "base64url").toString()) : 0;
      const end = start + limit;
      return send(200, { object: "list", data: rows.slice(start, end), nextCursor: end < rows.length ? Buffer.from(String(end)).toString("base64url") : null });
    }
    // One item of a list: GET /v2/contacts/{id}.
    const items = LISTS[parent];
    if (items) {
      const id = decodeURIComponent(url.pathname.slice(parent.length + 1));
      // One article takes state=live (the default) or draft, as Featurebase does: never all.
      if (items.fixtures === "articles" && state === "all") {
        return send(400, { error: { type: "invalid_request_error", code: "invalid_parameter", message: "Invalid state", status: 400 } });
      }
      const draft = items.fixtures === "articles" && state === "draft" ? fake.fixtures.articleDrafts.find((item) => item.id === id) : undefined;
      const found = draft ?? (fake.fixtures[items.fixtures] as (Row | null)[]).find((item) => item?.id === id);
      // Read live (the default), a never-published article isn't found.
      const row = items.fixtures === "articles" && state === "live" && found?.state === "draft" ? undefined : found;
      return row ? send(200, row) : send(404, { error: { type: "invalid_request_error", code: "resource_not_found", message: "Not found", status: 404 } });
    }
    return send(404, { message: `the fake doesn't serve ${req.method} ${url.pathname}` });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const fake: FeaturebaseFake = {
    url,
    env: { FEATUREBASE_API_URL: url },
    fixtures: featurebaseFixtures(),
    pageSize: 100,
    requests: [],
    forbidden: new Set(),
    failNext: (status, times = 1, headers = {}, body, path) => void (failing = { status, times, headers, body, path }),
    release: () => {
      released = true;
      for (const [go, timer] of held) {
        clearTimeout(timer);
        held.delete(go);
        go();
      }
    },
    file: (name, type, body) => {
      files.set(name, { type, body });
      return `${url}/files/${encodeURIComponent(name)}`;
    },
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
  return fake;
}
