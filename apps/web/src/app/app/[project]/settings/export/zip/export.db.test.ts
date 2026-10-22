import { prisma } from "@tuti/db";
import { strFromU8, unzipSync } from "fflate";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

import { lastingMediaUrl } from "@/server/media-urls";
import { actAs, addMember, createProject, signUp } from "@/test/helpers";

import { GET } from "./route";

/** "Export as Markdown" in settings: a ZIP of the project's articles, changelog and posts. */

const IMAGE_ID = "a".repeat(24);

beforeEach(() => {
  for (const [name, value] of Object.entries({
    MEDIA_S3_ENDPOINT: "http://127.0.0.1:1",
    MEDIA_S3_BUCKET: "media",
    MEDIA_S3_ACCESS_KEY_ID: "key",
    MEDIA_S3_SECRET_ACCESS_KEY: "secret",
  })) {
    vi.stubEnv(name, value);
  }
});
afterEach(() => vi.unstubAllEnvs());

const doc = (...content: object[]) => ({ type: "doc", content });
const paragraph = (text: string) => ({ type: "paragraph", content: [{ type: "text", text }] });
const exportOf = (slug: string) => GET(new Request("http://x"), { params: Promise.resolve({ project: slug }) });

async function seed() {
  const owner = await signUp("Olive Owner");
  const project = await createProject(owner);
  const projectId = project.id;
  const board = project.boards[0]!;

  const collection = await prisma.collection.create({ data: { projectId, slug: "getting-started", name: "Getting started" } });
  await prisma.article.create({
    data: {
      projectId,
      slug: "inviting-your-team",
      customSlug: true,
      title: 'Inviting "your" team',
      description: "Add teammates to your project.",
      keywords: ["add teammates", "Seats"],
      noindex: true,
      collectionId: collection.id,
      publishedAt: new Date("2026-03-01T10:00:00Z"),
      updatedAt: new Date("2026-03-02T10:00:00Z"),
      content: doc(paragraph("Owners can invite."), { type: "image", attrs: { mediaId: IMAGE_ID, alt: "Team page", w: 800, h: 600 } }),
    },
  });
  await prisma.article.create({ data: { projectId, slug: "secret-draft", title: "Secret draft", body: "Not yet." } });

  const ada = await signUp("Ada");
  const bob = await signUp("Bob");
  const post = await prisma.post.create({
    data: { projectId, boardId: board.id, authorId: ada.id, number: 7, title: "Dark mode!", body: "Please.", status: "COMPLETED", voteCount: 3 },
  });
  await prisma.comment.create({ data: { projectId, postId: post.id, authorId: bob.id, body: "Yes, please.", createdAt: new Date("2026-03-03T10:00:00Z") } });
  await prisma.comment.create({ data: { projectId, postId: post.id, authorId: owner.id, body: "Shipped.", createdAt: new Date("2026-03-04T10:00:00Z") } });

  await prisma.changelogEntry.create({
    data: {
      projectId,
      number: 2,
      title: "Dark mode",
      content: doc(paragraph("It's here.")),
      tags: ["NEW", "IMPROVED"],
      publishedAt: new Date("2026-03-05T10:00:00Z"),
      posts: { create: { postId: post.id } },
    },
  });
  await prisma.changelogEntry.create({ data: { projectId, number: 3, title: "Next up", body: "Soon." } });
  return { owner, project, emails: [owner.email, ada.email, bob.email] };
}

async function unzip(response: Response) {
  const files = unzipSync(new Uint8Array(await response.arrayBuffer()));
  return Object.fromEntries(Object.entries(files).map(([path, bytes]) => [path, strFromU8(bytes)]));
}

test("owners download everything as Markdown with front matter, drafts included, and no emails", async () => {
  const { owner, project, emails } = await seed();
  const other = await createProject(await signUp());
  await prisma.article.create({ data: { projectId: other.id, slug: "elsewhere", title: "Other project's article" } });

  actAs(owner);
  const response = await exportOf(project.slug);
  expect(response.status).toBe(200);
  expect(response.headers.get("content-type")).toBe("application/zip");
  expect(response.headers.get("content-disposition")).toMatch(
    new RegExp(`^attachment; filename="${project.slug}-export-\\d{4}-\\d{2}-\\d{2}\\.zip"$`),
  );
  const files = await unzip(response);

  expect(Object.keys(files).sort()).toEqual([
    "README.md",
    "changelog/2-dark-mode.md",
    "changelog/3-next-up.md",
    "docs/getting-started/inviting-your-team.md",
    "docs/secret-draft.md",
    "posts/feature-requests/7-dark-mode.md",
  ]);
  expect(files["README.md"]).toContain(`# Project ${project.slug}`);
  expect(files["README.md"]).toContain("images aren't in this ZIP");

  expect(files["docs/getting-started/inviting-your-team.md"]).toBe(
    [
      "---",
      'title: "Inviting \\"your\\" team"',
      'status: "published"',
      'listing: "everywhere"',
      "publishedAt: 2026-03-01T10:00:00.000Z",
      "updatedAt: 2026-03-02T10:00:00.000Z",
      'collection: "Getting started"',
      "order: 0",
      'description: "Add teammates to your project."',
      'keywords: ["add teammates","Seats"]',
      "noindex: true",
      "customSlug: true",
      "---",
      "",
      "Owners can invite.",
      "",
      `![Team page](${lastingMediaUrl(`m/${IMAGE_ID}/800.webp`)})`,
      "",
    ].join("\n"),
  );
  expect(files["docs/secret-draft.md"]).toMatch(/^---\ntitle: "Secret draft"\nstatus: "draft"\nlisting: "everywhere"\npublishedAt: null\nupdatedAt: .+\ncollection: null\norder: 0\ndescription: ""\nkeywords: \[\]\nnoindex: false\n---\n\nNot yet\.\n$/);

  expect(files["changelog/2-dark-mode.md"]).toBe(
    '---\ntitle: "Dark mode"\nstatus: "published"\npublishedAt: 2026-03-05T10:00:00.000Z\ntags: ["new","improved"]\ncompletes: [7]\n---\n\nIt\'s here.\n',
  );
  expect(files["changelog/3-next-up.md"]).toContain('status: "draft"');

  expect(files["posts/feature-requests/7-dark-mode.md"]).toMatch(
    /^---\ntitle: "Dark mode!"\nstatus: "completed"\nvotes: 3\nauthor: "Ada"\ncreatedAt: .+\n---\n\nPlease\.\n\n## Comments\n\n### Bob · 2026-03-03\n\nYes, please\.\n\n### Olive Owner · 2026-03-04\n\nShipped\.\n$/,
  );

  const everything = Object.values(files).join("\n");
  for (const email of emails) {
    expect(everything).not.toContain(email);
  }
  expect(everything).not.toContain("@example.com");
  expect(everything).not.toContain("Other project's article");
});

test("admins can export; members, outsiders and signed-out visitors get a 404", async () => {
  const { project } = await seed();
  const admin = await addMember(project.id, "ADMIN");
  const member = await addMember(project.id, "MEMBER");
  const outsider = await signUp();

  actAs(admin);
  expect((await exportOf(project.slug)).status).toBe(200);
  for (const user of [member, outsider, null]) {
    actAs(user);
    const response = await exportOf(project.slug);
    expect(response.status).toBe(404);
    expect(response.headers.get("content-type")).not.toBe("application/zip");
  }
});

test("a project with more rows than one batch exports all of them", async () => {
  const owner = await signUp();
  const { id: projectId, slug, boards } = await createProject(owner);
  await prisma.post.createMany({
    data: Array.from({ length: 205 }, (_, i) => ({ projectId, boardId: boards[0]!.id, authorId: owner.id, number: i + 1, title: `Idea ${i + 1}` })),
  });
  actAs(owner);
  const files = await unzip(await exportOf(slug));
  expect(Object.keys(files).filter((path) => path.startsWith("posts/"))).toHaveLength(205);
});

test("a collection in another is a folder in its folder, and each article says its place", async () => {
  const owner = await signUp();
  const { id: projectId, slug } = await createProject(owner);
  const billing = await prisma.collection.create({ data: { projectId, slug: "billing", name: "Billing" } });
  const invoices = await prisma.collection.create({ data: { projectId, slug: "invoices", name: "Invoices", parentId: billing.id } });
  await prisma.article.createMany({
    data: [
      { projectId, slug: "card-payments", title: "Card payments", collectionId: billing.id },
      { projectId, slug: "downloading", title: "Downloading", collectionId: invoices.id, order: 1 },
    ],
  });
  actAs(owner);
  const files = await unzip(await exportOf(slug));
  expect(Object.keys(files).filter((path) => path.startsWith("docs/"))).toEqual(
    expect.arrayContaining(["docs/billing/card-payments.md", "docs/billing/invoices/downloading.md"]),
  );
  expect(files["docs/billing/invoices/downloading.md"]).toContain('collection: "Invoices"\norder: 1\n');
});

test("collections nest as folders at any depth, in their top-level one's tab's folder", async () => {
  const owner = await signUp();
  const { id: projectId, slug } = await createProject(owner);
  const tab = await prisma.docsTab.create({ data: { projectId, slug: "guides", name: "Guides" } });
  let parentId: string | null = null;
  for (const name of ["Billing", "Invoices", "Taxes", "Europe"]) {
    const created: { id: string } = await prisma.collection.create({
      data: { projectId, slug: name.toLowerCase(), name, parentId, tabId: parentId ? null : tab.id },
    });
    parentId = created.id;
  }
  await prisma.article.create({ data: { projectId, slug: "vat", title: "VAT", collectionId: parentId } });
  actAs(owner);
  const files = await unzip(await exportOf(slug));
  expect(files["docs/guides/billing/invoices/taxes/europe/vat.md"]).toContain('tab: "Guides"\ncollection: "Europe"\n');
});
