import { originalKey, videoKey } from "@tuti/content";
import { prisma } from "@tuti/db";
import { handlers } from "@tuti/jobs";
import { SIGNED_WINDOW_SECONDS } from "@tuti/shared/storage";
import { type S3Fake, startS3Fake } from "@tuti/testkit";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";

import { articleMarkdown } from "@/server/docs-queries";
import { createUpload, finishUpload } from "@/server/media";
import { GET } from "@/app/media/[id]/[file]/route";
import { lastingMediaUrl, mediaUrls } from "@/server/media-urls";
import { createArticle } from "@/server/operations/docs";
import { call } from "@/server/operations/run";
import { actAs, createProject, signUp, type TestUser } from "@/test/helpers";

/** Videos in articles: the team's uploads, by the file attachments' path, checked by content, played in place. */

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
/** The start of an MP4 (an ISO media file's `ftyp` box), then made-up frames. */
const MP4 = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from("ftypisom\0\0\0\0isommp41"), Buffer.alloc(64, 7)]);
const PDF = Buffer.from("%PDF-1.7\n%%EOF\n");

/** Uploads like the editor does: ask for a URL, PUT it with the type signed, finish. */
async function upload(name: string, body: Buffer) {
  const created = await createUpload(project.slug, { name, type: "", size: body.length });
  if ("error" in created) {
    return created;
  }
  const put = await fetch(created.uploadUrl, { method: "PUT", body: new Uint8Array(body), headers: { "content-type": created.contentType } });
  expect(put.ok).toBe(true);
  return { ...(await finishUpload(created.mediaId)), mediaId: created.mediaId, contentType: created.contentType };
}

const videoNode = (id: string) => ({ type: "video", attrs: { provider: "upload", id } });
const doc = (...nodes: object[]) => ({ type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "Watch:" }] }, ...nodes] });
const asOwner = () => ({ actor: { kind: "user" as const, userId: owner.id }, projectId: project.id });

describe("uploads", () => {
  test("the team uploads an MP4: signed as a video, copied by the storage where the upload URL can't reach, and ready to play", async () => {
    const result = await upload("Tour.mp4", MP4);
    expect(result).toEqual({ mediaId: expect.any(String), contentType: "video/mp4", src: expect.stringContaining("/m/") });
    const { mediaId } = result as { mediaId: string };
    expect(await prisma.media.findUniqueOrThrow({ where: { id: mediaId } })).toMatchObject({ status: "READY", filename: "Tour.mp4", size: MP4.length });
    expect(s3.objects.get(videoKey(mediaId))).toEqual({ body: MP4, contentType: "video/mp4" });
    expect(s3.objects.has(originalKey(mediaId))).toBe(false);
  });

  test("a web page named as a video is refused, and kept nowhere", async () => {
    const result = await upload("clip.mp4", Buffer.from("<!doctype html><script>alert(1)</script>"));
    expect(result).toMatchObject({ error: "clip.mp4 isn't a video" });
    const { mediaId } = result as unknown as { mediaId: string };
    expect(await prisma.media.findUniqueOrThrow({ where: { id: mediaId } })).toMatchObject({ status: "FAILED", size: 0 });
    expect(s3.objects.has(videoKey(mediaId))).toBe(false);
  });

  test("only the team uploads videos; people on the portal can't", async () => {
    actAs(await signUp("Ada"));
    expect(await createUpload(project.slug, { name: "a.mp4", type: "video/mp4", size: 10 })).toEqual({ error: "Only the team can attach files" });
  });

  test("videos can be up to 200 MB, or what MEDIA_MAX_VIDEO_MB_TEAM says; they share the project's quota", async () => {
    expect(await createUpload(project.slug, { name: "big.webm", type: "", size: 201 * MB })).toEqual({ error: "Videos can be up to 200 MB" });
    vi.stubEnv("MEDIA_MAX_VIDEO_MB_TEAM", "300");
    expect(await createUpload(project.slug, { name: "big.mov", type: "", size: 201 * MB })).toMatchObject({ contentType: "video/quicktime" });
    vi.stubEnv("MEDIA_PROJECT_QUOTA_MB", "202");
    expect(await createUpload(project.slug, { name: "more.mp4", type: "", size: 2 * MB })).toEqual({ error: "This project has no space left for files" });
  });
});

describe("in articles", () => {
  test("a saved video is kept by the sweep, plays from its lasting link (still, hours after the page), and Markdown links it", async () => {
    const { mediaId } = (await upload("Tour.mp4", MP4)) as { mediaId: string };
    await call(createArticle, asOwner(), { title: "Tour", content: doc(videoNode(mediaId)) });
    const article = await prisma.article.findFirstOrThrow({ where: { projectId: project.id }, select: { content: true } });
    expect((article.content as { content: object[] }).content[1]).toEqual(videoNode(mediaId));

    // Saved two days ago: the daily sweep still finds it in the article and keeps it.
    await prisma.media.update({ where: { id: mediaId }, data: { attachedAt: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000) } });
    await handlers.releaseMedia({}, { info: () => {}, warn: () => {} });
    expect((await prisma.media.findUniqueOrThrow({ where: { id: mediaId } })).attachedAt).not.toBeNull();

    // The player loads its lasting link, not a URL signed for this page view: it asks for more as it's played or sought.
    const url = (await mediaUrls(article.content as object))![videoKey(mediaId)]!;
    expect(url).toBe(lastingMediaUrl(videoKey(mediaId)));
    // Three hours on, past any URL signed as the page was shown, each request still goes on to one signed now, and plays
    // in place, as its video type, not a download.
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(Date.now() + 3 * 60 * 60 * 1000);
      const link = new URL(url);
      const redirect = await GET(new Request(link), { params: Promise.resolve({ id: mediaId, file: "video" }) });
      expect(redirect.status).toBe(302);
      const location = new URL(redirect.headers.get("location")!);
      const windowStart = Date.now() - (Date.now() % (SIGNED_WINDOW_SECONDS * 1000));
      expect(location.searchParams.get("X-Amz-Date")).toBe(new Date(windowStart).toISOString().replace(/[:-]|\.\d{3}/g, ""));
      const response = await fetch(location);
      expect(response.headers.get("content-type")).toBe("video/mp4");
      expect(response.headers.get("content-disposition")).toBeNull();
      expect(Buffer.from(await response.arrayBuffer())).toEqual(MP4);
    } finally {
      vi.useRealTimers();
    }

    expect(await articleMarkdown({ title: "Tour", doc: article.content as never })).toBe(`# Tour\n\nWatch:\n\n[Video](${url})\n`);
  });

  test("a video node plays only a video upload, and a file attachment can't hold one", async () => {
    const { mediaId: pdf } = (await upload("a.pdf", PDF)) as { mediaId: string };
    const { mediaId: video } = (await upload("a.mp4", MP4)) as { mediaId: string };
    await expect(call(createArticle, asOwner(), { title: "One", content: doc(videoNode(pdf)) })).rejects.toThrow("A file is still uploading");
    const asFile = { type: "file", attrs: { mediaId: video, name: "a.mp4", size: 1 } };
    await expect(call(createArticle, asOwner(), { title: "Two", content: doc(asFile) })).rejects.toThrow("A file is still uploading");
  });
});
