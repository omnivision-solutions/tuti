import { fileKey, originalKey } from "@tuti/content";
import { prisma } from "@tuti/db";
import { handlers } from "@tuti/jobs";
import { mediaStorage } from "@tuti/shared/storage";
import { type S3Fake, startS3Fake } from "@tuti/testkit";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";

import { readContent } from "@/server/content";
import { articleMarkdown } from "@/server/docs-queries";
import { createUpload, finishUpload } from "@/server/media";
import { mediaUrls } from "@/server/media-urls";
import { updateBranding } from "@/server/operations/branding";
import { createChangelogEntry } from "@/server/operations/changelog";
import { createArticle } from "@/server/operations/docs";
import { call } from "@/server/operations/run";
import { actAs, createProject, signUp, type TestUser } from "@/test/helpers";

/** File attachments in articles: the team's uploads, checked by name and content, kept by the content using them, and only ever downloaded. */

let s3: S3Fake;
let owner: TestUser;
let project: Awaited<ReturnType<typeof createProject>>;

beforeAll(async () => {
  s3 = await startS3Fake();
});
afterAll(() => s3.close());

beforeEach(async () => {
  for (const [name, value] of Object.entries(s3.env)) {
    vi.stubEnv(name, value);
  }
  owner = await signUp("Olive Owner");
  project = await createProject(owner);
  actAs(owner);
});
afterEach(() => vi.unstubAllEnvs());

const MB = 1024 * 1024;
const PDF = Buffer.from("%PDF-1.7\n1 0 obj << >> endobj\n%%EOF\n");

/** Attaches a file like the editor does: ask for a URL (as `type` says the browser sent it), PUT it with the type signed, finish. */
async function attach(name: string, body: Buffer, type = "") {
  const created = await createUpload(project.slug, { name, type, size: body.length });
  if ("error" in created) {
    return created;
  }
  const put = await fetch(created.uploadUrl, { method: "PUT", body: new Uint8Array(body), headers: { "content-type": created.contentType } });
  expect(put.ok).toBe(true);
  const finished = await finishUpload(created.mediaId);
  return { ...finished, mediaId: created.mediaId, contentType: created.contentType };
}

const fileNode = (mediaId: string, attrs: object = {}) => ({ type: "file", attrs: { mediaId, name: "whatever.exe", size: 1, ...attrs } });
const doc = (...nodes: object[]) => ({ type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "Download:" }] }, ...nodes] });
const asOwner = () => ({ actor: { kind: "user" as const, userId: owner.id }, projectId: project.id });

describe("uploads", () => {
  test("the team attaches a PDF: signed as one whatever the browser said, kept as it is, and counted in the quota", async () => {
    const result = await attach("Price list.pdf", PDF, "application/x-whatever");
    expect(result).toEqual({ mediaId: expect.any(String), contentType: "application/pdf" });
    const { mediaId } = result as { mediaId: string };
    expect(await prisma.media.findUniqueOrThrow({ where: { id: mediaId } })).toMatchObject({
      status: "READY",
      filename: "Price list.pdf",
      size: PDF.length,
      width: null,
    });
    expect(s3.objects.get(fileKey(mediaId))?.body).toEqual(PDF);
  });

  test("a copy that fails keeps the upload, so finishing again works", async () => {
    const created = await createUpload(project.slug, { name: "a.pdf", type: "", size: PDF.length });
    const { mediaId, uploadUrl, contentType } = created as { mediaId: string; uploadUrl: string; contentType: string };
    await fetch(uploadUrl, { method: "PUT", body: new Uint8Array(PDF), headers: { "content-type": contentType } });
    s3.failPuts.add(fileKey(mediaId));
    expect(await finishUpload(mediaId)).toEqual({ error: "The file couldn't be saved. Try again." });
    s3.failPuts.clear();
    expect(await finishUpload(mediaId)).toEqual({});
    expect(s3.objects.get(fileKey(mediaId))?.body).toEqual(PDF);
    expect(s3.objects.has(originalKey(mediaId))).toBe(false);
  });

  test("checking a file reads at most one byte more than declared (a ranged GET), whatever is there", async () => {
    s3.objects.set("uploads/big", { body: Buffer.alloc(1000), contentType: "application/pdf" });
    expect((await mediaStorage()!.get("uploads/big", 11)).length).toBe(11);
    expect((await mediaStorage()!.get("uploads/big")).length).toBe(1000);
  });

  test("a file swapped for a bigger one between the size check and the read is refused, read only as far as it shows", async () => {
    const created = await createUpload(project.slug, { name: "a.pdf", type: "", size: PDF.length });
    const { mediaId, uploadUrl, contentType } = created as { mediaId: string; uploadUrl: string; contentType: string };
    await fetch(uploadUrl, { method: "PUT", body: new Uint8Array(PDF), headers: { "content-type": contentType } });
    const ranges: (string | undefined)[] = [];
    s3.beforeGet = (key, range) => {
      ranges.push(range);
      s3.objects.set(key, { body: Buffer.concat([PDF, Buffer.alloc(1000)]), contentType });
    };
    try {
      expect(await finishUpload(mediaId)).toEqual({ error: "The upload didn't match the file. Try again." });
    } finally {
      s3.beforeGet = undefined;
    }
    expect(ranges).toEqual([`bytes=0-${PDF.length}`]);
    expect(await prisma.media.findUniqueOrThrow({ where: { id: mediaId } })).toMatchObject({ status: "FAILED", size: 0 });
    expect(s3.objects.has(fileKey(mediaId))).toBe(false);
  });

  test("a leftover upload that can't be deleted doesn't stop the file being attached", async () => {
    const created = await createUpload(project.slug, { name: "a.pdf", type: "", size: PDF.length });
    const { mediaId, uploadUrl, contentType } = created as { mediaId: string; uploadUrl: string; contentType: string };
    await fetch(uploadUrl, { method: "PUT", body: new Uint8Array(PDF), headers: { "content-type": contentType } });
    s3.failDeletes.add(originalKey(mediaId));
    expect(await finishUpload(mediaId)).toEqual({});
    s3.failDeletes.clear();
    expect(await prisma.media.findUniqueOrThrow({ where: { id: mediaId } })).toMatchObject({ status: "READY" });
  });

  test("of two finishes at once, a refusal landing first keeps the other from making it READY with no size", async () => {
    const created = await createUpload(project.slug, { name: "a.pdf", type: "", size: PDF.length });
    const { mediaId, uploadUrl, contentType } = created as { mediaId: string; uploadUrl: string; contentType: string };
    await fetch(uploadUrl, { method: "PUT", body: new Uint8Array(PDF), headers: { "content-type": contentType } });
    // While this finish reads the file, another refuses it (as it would a page put there through the upload URL).
    s3.beforeGet = async () => {
      await prisma.media.update({ where: { id: mediaId }, data: { status: "FAILED", size: 0 } });
    };
    try {
      expect(await finishUpload(mediaId)).toEqual({ error: "The upload didn't match the file. Try again." });
    } finally {
      s3.beforeGet = undefined;
    }
    expect(await prisma.media.findUniqueOrThrow({ where: { id: mediaId } })).toMatchObject({ status: "FAILED", size: 0 });
  });

  test("of two finishes at once reading different valid files, only the first to claim it writes the file", async () => {
    const created = await createUpload(project.slug, { name: "a.pdf", type: "", size: PDF.length });
    const { mediaId, uploadUrl, contentType } = created as { mediaId: string; uploadUrl: string; contentType: string };
    await fetch(uploadUrl, { method: "PUT", body: new Uint8Array(PDF), headers: { "content-type": contentType } });
    const other = Buffer.from(PDF.toString().replace("1.7", "1.6"));
    // While this finish reads, another finishes the original; then the upload URL puts another valid PDF there.
    s3.beforeGet = async (key) => {
      s3.beforeGet = undefined;
      expect(await finishUpload(mediaId)).toEqual({});
      s3.objects.set(key, { body: other, contentType });
    };
    try {
      expect(await finishUpload(mediaId)).toEqual({});
    } finally {
      s3.beforeGet = undefined;
    }
    expect(s3.objects.get(fileKey(mediaId))?.body).toEqual(PDF);
  });

  test("a finish whose read fails doesn't give back another finish's claim", async () => {
    const created = await createUpload(project.slug, { name: "a.pdf", type: "", size: PDF.length });
    const { mediaId, uploadUrl, contentType } = created as { mediaId: string; uploadUrl: string; contentType: string };
    await fetch(uploadUrl, { method: "PUT", body: new Uint8Array(PDF), headers: { "content-type": contentType } });
    // Another finish has claimed it and is copying; this one's read fails.
    s3.beforeGet = async (key) => {
      await prisma.media.update({ where: { id: mediaId }, data: { status: "PROCESSING" } });
      s3.objects.delete(key);
    };
    try {
      expect(await finishUpload(mediaId)).toEqual({ error: "The file couldn't be saved. Try again." });
    } finally {
      s3.beforeGet = undefined;
    }
    expect((await prisma.media.findUniqueOrThrow({ where: { id: mediaId } })).status).toBe("PROCESSING");
  });

  test("a finish that loses to another that kept the file says it's done", async () => {
    const created = await createUpload(project.slug, { name: "a.pdf", type: "", size: PDF.length });
    const { mediaId, uploadUrl, contentType } = created as { mediaId: string; uploadUrl: string; contentType: string };
    await fetch(uploadUrl, { method: "PUT", body: new Uint8Array(PDF), headers: { "content-type": contentType } });
    s3.beforeGet = async () => {
      await prisma.media.update({ where: { id: mediaId }, data: { status: "READY" } });
    };
    try {
      expect(await finishUpload(mediaId)).toEqual({});
    } finally {
      s3.beforeGet = undefined;
    }
    expect(await prisma.media.findUniqueOrThrow({ where: { id: mediaId } })).toMatchObject({ status: "READY", size: PDF.length });
  });

  test("once checked, the upload URL can't swap the file for another", async () => {
    const created = await createUpload(project.slug, { name: "a.pdf", type: "", size: PDF.length });
    const { mediaId, uploadUrl, contentType } = created as { mediaId: string; uploadUrl: string; contentType: string };
    const put = (body: Buffer) => fetch(uploadUrl, { method: "PUT", body: new Uint8Array(body), headers: { "content-type": contentType } });
    await put(PDF);
    expect(await finishUpload(mediaId)).toEqual({});
    expect(s3.objects.has(originalKey(mediaId))).toBe(false);
    // Same size, so the signed PUT takes it: it lands beside the checked file, never on it.
    await put(Buffer.from("<html>".padEnd(PDF.length, " ")));
    expect(s3.objects.get(fileKey(mediaId))?.body).toEqual(PDF);
  });

  test.each(["page.html", "logo.svg", "setup.exe", "run.sh", "app.js", "README"])("refuses %s", async (name) => {
    expect(await attach(name, Buffer.from("hello"))).toEqual({
      error: "Only PDF, text (TXT, CSV, Markdown), JSON, ZIP, and Office or OpenDocument files can be attached",
    });
  });

  test.each([
    ["a web page named as a PDF", "invoice.pdf", Buffer.from("<html><script>alert(1)</script></html>")],
    ["a web page named as text", "notes.txt", Buffer.from("  <!DOCTYPE html><html></html>")],
    ["an SVG named as Markdown", "notes.md", Buffer.from("<svg onload='alert(1)'></svg>")],
    ["a program named as a ZIP", "files.zip", Buffer.from("MZ\x90\x00program")],
    ["a UTF-16 web page named as text", "notes.txt", Buffer.from("\ufeff<html><script>alert(1)</script></html>", "utf16le")],
  ])("checks content, not the name: %s is refused and deleted", async (_, name, body) => {
    const created = await createUpload(project.slug, { name, type: "", size: body.length });
    const { mediaId, uploadUrl, contentType } = created as { mediaId: string; uploadUrl: string; contentType: string };
    await fetch(uploadUrl, { method: "PUT", body: new Uint8Array(body), headers: { "content-type": contentType } });
    expect(await finishUpload(mediaId)).toEqual({ error: `${name} isn't a ${name.split(".")[1]!.toUpperCase()} file` });
    expect(await prisma.media.findUniqueOrThrow({ where: { id: mediaId } })).toMatchObject({ status: "FAILED", size: 0 });
    expect(s3.objects.has(fileKey(mediaId))).toBe(false);
    expect(s3.objects.has(originalKey(mediaId))).toBe(false);
  });

  test("text, CSV, JSON and Office files (ZIPs inside) are fine", async () => {
    for (const [name, body] of [
      ["notes.md", Buffer.from("# Setup\n\nÜber <details> too")],
      ["data.csv", Buffer.from("a,b\n1,2\n")],
      ["config.json", Buffer.from('{"a":1}')],
      // Excel's CSV (Windows code page: "Café,10") and "Unicode text" (UTF-16).
      ["prices.csv", Buffer.from([0x43, 0x61, 0x66, 0xe9, 0x2c, 0x31, 0x30, 0x0d, 0x0a])],
      ["notes.txt", Buffer.from("\ufeffHello, world", "utf16le")],
      ["report.docx", Buffer.from("PK\x03\x04rest")],
      ["old.xls", Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0])],
      // Password-protected: Office encrypts it into an OLE file.
      ["Price list.xlsx", Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0])],
    ] as const) {
      expect(await attach(name, Buffer.from(body))).not.toHaveProperty("error");
    }
  });

  test("a long name is shortened to the end of it, and that's the name the editor shows", async () => {
    const name = `${"a".repeat(250)}.pdf`;
    const created = await createUpload(project.slug, { name, type: "", size: 10 });
    expect(created).toMatchObject({ name: name.slice(-200) });
  });

  test("an empty file says so", async () => {
    expect(await createUpload(project.slug, { name: "notes.txt", type: "", size: 0 })).toEqual({ error: "This file is empty" });
  });

  test("only the team attaches files; people on the portal can't", async () => {
    actAs(await signUp("Ada"));
    expect(await createUpload(project.slug, { name: "a.pdf", type: "application/pdf", size: 10 })).toEqual({ error: "Only the team can attach files" });
  });

  test("files can be up to 25 MB, or what MEDIA_MAX_FILE_MB_TEAM says; they share the project's quota", async () => {
    expect(await createUpload(project.slug, { name: "big.pdf", type: "", size: 26 * MB })).toEqual({ error: "Files can be up to 25 MB" });
    vi.stubEnv("MEDIA_MAX_FILE_MB_TEAM", "30");
    expect(await createUpload(project.slug, { name: "big.pdf", type: "", size: 26 * MB })).toHaveProperty("mediaId");
    vi.stubEnv("MEDIA_PROJECT_QUOTA_MB", "27");
    expect(await createUpload(project.slug, { name: "more.pdf", type: "", size: 2 * MB })).toEqual({ error: "This project has no space left for files" });
  });
});

describe("in articles", () => {
  test("a saved attachment takes its name and size from the upload, is kept by the sweep, and downloads under its name", async () => {
    const { mediaId } = (await attach("Price list (2026).pdf", PDF)) as { mediaId: string };
    await call(createArticle, asOwner(), { title: "Pricing", content: doc(fileNode(mediaId)) });
    const article = await prisma.article.findFirstOrThrow({ where: { projectId: project.id }, select: { content: true, body: true } });
    expect((article.content as { content: object[] }).content[1]).toEqual(fileNode(mediaId, { name: "Price list (2026).pdf", size: PDF.length }));
    // Search reads the upload's name, not the one the request sent.
    expect(article.body).toBe("Download:\nPrice list (2026).pdf");

    // Saved two days ago: the daily sweep still finds it in the article and keeps it.
    await prisma.media.update({ where: { id: mediaId }, data: { attachedAt: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000) } });
    await handlers.releaseMedia({}, { info: () => {}, warn: () => {} });
    expect((await prisma.media.findUniqueOrThrow({ where: { id: mediaId } })).attachedAt).not.toBeNull();

    // Signed as a download: saved under its name, as plain bytes, never shown on the storage's host.
    const url = (await mediaUrls(article.content as object))![fileKey(mediaId)]!;
    const response = await fetch(url);
    expect(response.headers.get("content-disposition")).toBe("attachment; filename*=UTF-8''Price%20list%20%282026%29.pdf");
    expect(response.headers.get("content-type")).toBe("application/octet-stream");
    expect(Buffer.from(await response.arrayBuffer())).toEqual(PDF);

    // The .md and "Copy as Markdown" link it the same way.
    expect(await articleMarkdown({ title: "Pricing", doc: article.content as never })).toBe(`# Pricing\n\nDownload:\n\n[Price list (2026).pdf](${url.replace(/[()]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)})\n`);
  });

  test("the length limit counts files' names as the uploads have them", async () => {
    const { mediaId } = (await attach(`${"a".repeat(100)}.pdf`, PDF)) as { mediaId: string };
    expect(await readContent("article", { content: doc(fileNode(mediaId, { name: "a.pdf" })) }, { projectId: project.id, maxLength: 50 })).toEqual({
      error: "Keep it under 50 characters",
    });
  });

  test("a file's upload can't be a changelog cover or a portal logo", async () => {
    const { mediaId } = (await attach("a.pdf", PDF)) as { mediaId: string };
    await expect(call(createChangelogEntry, asOwner(), { title: "Dark mode", body: "x", cover: mediaId })).rejects.toThrow("An image is still uploading");
    await expect(call(updateBranding, asOwner(), { logo: mediaId })).rejects.toThrow("An image is still uploading");
  });

  test("a file can't be shown as an image, nor an image attached as a file", async () => {
    const { mediaId } = (await attach("a.pdf", PDF)) as { mediaId: string };
    const image = await prisma.media.create({ data: { projectId: project.id, uploaderId: owner.id, size: 1, status: "READY", width: 10, height: 10 } });
    const asImage = { type: "image", attrs: { mediaId, width: "100", align: "center", alt: "" } };
    await expect(call(createArticle, asOwner(), { title: "One", content: doc(asImage) })).rejects.toThrow("An image is still uploading");
    await expect(call(createArticle, asOwner(), { title: "Two", content: doc(fileNode(image.id)) })).rejects.toThrow("A file is still uploading");
    // One that's gone (deleted a day after it was left unsaved) says it's a file.
    await prisma.media.delete({ where: { id: mediaId } });
    await expect(call(createArticle, asOwner(), { title: "Three", content: doc(fileNode(mediaId)) })).rejects.toThrow(
      "A file is still uploading or can't be used here. Wait for it, or attach it again.",
    );
  });
});
