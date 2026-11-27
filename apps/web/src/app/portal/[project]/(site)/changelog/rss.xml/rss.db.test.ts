import { prisma } from "@tuti/db";
import { expect, test } from "vitest";

import { createProject, signUp } from "@/test/helpers";
import { request } from "@/test/next-headers";
import { updateLanguages } from "@/server/operations/languages";
import { call } from "@/server/operations/run";

import { GET } from "./route";

test("the changelog feed lists published entries only, newest first, with text that can't break the XML", async () => {
  const owner = await signUp();
  const project = await createProject(owner);
  const entry = (number: number, title: string, publishedAt: Date | null, extra: object = {}) =>
    prisma.changelogEntry.create({ data: { projectId: project.id, number, title, body: "", publishedAt, ...extra } });
  await entry(1, "Old\u000Ber", new Date("2026-01-01T10:00:00Z")); // a control character XML forbids
  await entry(2, "Draft only", null);
  await entry(3, "Tags & <things>", new Date("2026-02-01T10:00:00Z"), {
    tags: ["NEW", "BREAKING"],
    content: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "Use </description> freely" }] }] },
  });

  const response = await GET(new Request("http://x"), { params: Promise.resolve({ project: project.slug }) });
  expect(response.headers.get("content-type")).toBe("application/rss+xml; charset=utf-8");
  const feed = await response.text();
  const titles = [...feed.matchAll(/<item><title>(.*?)<\/title>/g)].map((m) => m[1]);
  expect(titles).toEqual(["Tags &amp; &lt;things&gt;", "Older"]);
  expect(feed).not.toContain("Draft only");
  expect(feed).toContain(`<link>http://${project.slug}.localhost:3100/changelog/3</link>`);
  expect(feed).toContain("<pubDate>Sun, 01 Feb 2026 10:00:00 GMT</pubDate>");
  expect(feed).toContain("<category>New</category><category>Breaking</category>");
  expect(feed).toContain("<description>Use &lt;/description&gt; freely</description>");

  const missing = await GET(new Request("http://x"), { params: Promise.resolve({ project: "no-such-project" }) });
  expect(missing.status).toBe(404);
});

test("at a language's address, the feed has each entry in its version there where it's current, else the default language's, and says its language", async () => {
  const owner = await signUp();
  const project = await createProject(owner);
  await call(updateLanguages, { actor: { kind: "user", userId: owner.id }, projectId: project.id }, { languages: [{ code: "de", live: true, newPages: "manual" }] });
  const translated = await prisma.changelogEntry.create({ data: { projectId: project.id, number: 1, title: "Dark mode", body: "Switch themes.", publishedAt: new Date("2026-01-01T10:00:00Z") } });
  await prisma.changelogEntry.create({ data: { projectId: project.id, number: 2, title: "Faster search", body: "Quicker.", publishedAt: new Date("2026-02-01T10:00:00Z") } });
  await prisma.changelogTranslation.create({
    data: { entryId: translated.id, projectId: project.id, language: "de", automatic: false, title: "Dunkler Modus", body: "Wechsle das Design.", publishedAt: new Date() },
  });
  const feed = async () => (await GET(new Request("http://x"), { params: Promise.resolve({ project: project.slug }) })).text();
  try {
    request.headers = { "x-tuti-language": "de", "x-tuti-language-prefix": "/de", "x-tuti-language-default": "en" };
    const german = await feed();
    expect([...german.matchAll(/<item><title>(.*?)<\/title>/g)].map((m) => m[1])).toEqual(["Faster search", "Dunkler Modus"]);
    expect(german).toContain("<description>Wechsle das Design.</description>");
    expect(german).toContain("<language>de</language>");
    expect(german).toContain(`<link>http://${project.slug}.localhost:3100/de/changelog/1</link>`);
    request.headers = { "x-tuti-language": "en", "x-tuti-language-default": "en" };
    const english = await feed();
    expect([...english.matchAll(/<item><title>(.*?)<\/title>/g)].map((m) => m[1])).toEqual(["Faster search", "Dark mode"]);
    expect(english).toContain("<language>en</language>");
  } finally {
    request.headers = {};
  }
});
