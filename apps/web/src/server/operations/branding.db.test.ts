import { imageKey, mediaKeys } from "@tuti/content/media";
import { prisma } from "@tuti/db";
import { handlers } from "@tuti/jobs";
import { type S3Fake, startS3Fake } from "@tuti/testkit";
import { afterAll, afterEach, beforeAll, beforeEach, expect, test, vi } from "vitest";
import type { z } from "zod";

import { actAs, addMember, createProject, signUp, type TestUser } from "@/test/helpers";
import { issueLicense } from "@/test/license";

import { saveBranding } from "../branding";
import { brandCss, getBranding, updateBranding } from "./branding";
import { call } from "./run";

vi.mock("@/server/license-key", async () => (await import("@/test/license")).testLicenseKey);

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
  owner = await signUp();
  project = await createProject(owner);
});
afterEach(() => vi.unstubAllEnvs());

const DAY = 24 * 60 * 60 * 1000;
const team = (projectId = project.id) => ({ actor: { kind: "user" as const, userId: owner.id }, projectId });
const update = (input: z.input<typeof updateBranding.input>) => call(updateBranding, team(), input);
const get = () => call(getBranding, team(), {});

/** A processed upload, made two days ago (so the cleanup takes it as soon as nothing uses it), with its files in storage. */
async function uploaded(fields: { projectId?: string; status?: "READY" | "PROCESSING"; attachedAt?: Date } = {}) {
  const media = await prisma.media.create({
    data: {
      projectId: project.id,
      uploaderId: owner.id,
      size: 10,
      status: "READY",
      width: 600,
      height: 200,
      createdAt: new Date(Date.now() - 2 * DAY),
      ...fields,
    },
  });
  for (const key of mediaKeys(media)) {
    s3.objects.set(key, { body: Buffer.from("x"), contentType: "image/webp" });
  }
  return media;
}

const attached = async (id: string) => (await prisma.media.findUnique({ where: { id }, select: { attachedAt: true } }))?.attachedAt ?? null;
const cleanup = () => handlers.cleanupMedia({}, { info: () => {}, warn: () => {} });
/** A day later, the daily release-media job: releases what nothing in the project uses any more. */
async function releaseADayLater() {
  await prisma.media.updateMany({ where: { projectId: project.id, attachedAt: { not: null } }, data: { attachedAt: new Date(Date.now() - 2 * DAY) } });
  await handlers.releaseMedia({}, { info: () => {}, warn: () => {} });
}

test("a project starts with no logos or favicon, the brand green, no links, and Powered by tuti", async () => {
  expect(await get()).toEqual({
    logo: null,
    logoDark: null,
    favicon: null,
    color: null,
    headerLinks: [],
    footerLinks: [],
    poweredBy: true,
    licensedUntil: null,
  });
});

test("admins set the colour, links and Powered by; each change leaves the rest", async () => {
  const saved = await update({
    licenseKey: issueLicense(project.id),
    color: "#5B21B6",
    headerLinks: [{ label: " Docs ", url: " https://docs.example.com " }],
    footerLinks: [
      { label: "Terms", url: "https://example.com/terms" },
      { label: "Privacy", url: "https://example.com/privacy" },
    ],
    poweredBy: false,
  });
  expect(saved).toMatchObject({
    color: "#5b21b6",
    headerLinks: [{ label: "Docs", url: "https://docs.example.com" }],
    footerLinks: [{ label: "Terms" }, { label: "Privacy" }],
    poweredBy: false,
  });
  expect(await update({ footerLinks: [] })).toMatchObject({ color: "#5b21b6", headerLinks: [{ label: "Docs" }], footerLinks: [], poweredBy: false });
  // Picking the brand green (or null) is the default again, with its dark-mode shade.
  expect((await update({ color: "#12804a" })).color).toBeNull();
  expect((await update({ color: "#5b21b6" })).color).toBe("#5b21b6");
  expect((await update({ color: null })).color).toBeNull();
  expect((await update({ poweredBy: true })).poweredBy).toBe(true);
});

test("settings are checked: https links, at most 5 of each, a real colour, and images that are this project's finished uploads", async () => {
  const refused = async (input: Parameters<typeof update>[0], message: string) =>
    expect(update(input)).rejects.toMatchObject({ status: 400, message });
  const links = (count: number) => Array(count).fill({ label: "Docs", url: "https://docs.example.com" });
  await refused({ headerLinks: [{ label: "Docs", url: "http://docs.example.com" }] }, "Links need a full https:// address");
  await refused({ footerLinks: [{ label: "Docs", url: "javascript:alert(1)" }] }, "Links need a full https:// address");
  await refused({ footerLinks: [{ label: " ", url: "https://docs.example.com" }] }, "Give each link a label");
  await refused({ headerLinks: links(6) }, "Add up to 5 header links");
  await refused({ footerLinks: links(6) }, "Add up to 5 footer links");
  await refused({ color: "red" }, "Pick a colour like #12804a");
  await refused({ color: "#000000;}body{display:none" }, "Pick a colour like #12804a");

  const gone = "An image is still uploading or can't be used here. Wait for it, or remove it.";
  const other = await createProject(owner);
  await refused({ logo: (await uploaded({ projectId: other.id })).id }, gone);
  await refused({ logo: (await uploaded({ status: "PROCESSING" })).id }, gone);
  await refused({ favicon: "no-such-upload" }, gone);

  // Nothing was saved.
  expect(await get()).toEqual({ logo: null, logoDark: null, favicon: null, color: null, headerLinks: [], footerLinks: [], poweredBy: true, licensedUntil: null });

  // An image already in use (a post's, or the logo just replaced) can be the logo: release-media checks every use.
  const inUse = await uploaded({ attachedAt: new Date() });
  expect(await update({ logoDark: inUse.id })).toMatchObject({ logoDark: { id: inUse.id } });
});

test("images are attached while used; a replaced or removed one is released by the daily job, for the cleanup to delete", async () => {
  const [logo, dark, favicon, newLogo] = [await uploaded(), await uploaded(), await uploaded(), await uploaded()];
  const saved = await update({ logo: logo.id, logoDark: dark.id, favicon: favicon.id });
  // Pages load the smallest stored size from the media host.
  expect(saved.logo).toEqual({ id: logo.id, url: `${s3.env.MEDIA_PUBLIC_URL}/${imageKey(logo.id, 480)}`, width: 600, height: 200 });
  expect(saved).toMatchObject({ logoDark: { id: dark.id }, favicon: { id: favicon.id } });
  for (const media of [logo, dark, favicon]) {
    expect(await attached(media.id)).not.toBeNull();
  }
  // Saving again with the same images (as the form does) keeps them.
  await update({ logo: logo.id, logoDark: dark.id, favicon: favicon.id, color: "#5b21b6" });
  expect(await attached(logo.id)).not.toBeNull();

  // The daily job keeps images the branding uses.
  await releaseADayLater();
  for (const media of [logo, dark, favicon]) {
    expect(await attached(media.id)).not.toBeNull();
  }

  // A new logo replaces the old one and the dark logo is removed; the favicon is left alone.
  expect(await update({ logo: newLogo.id, logoDark: null })).toMatchObject({ logo: { id: newLogo.id }, logoDark: null, favicon: { id: favicon.id } });
  expect(await attached(newLogo.id)).not.toBeNull();
  // The daily job releases the ones nothing uses any more.
  await releaseADayLater();
  expect(await attached(logo.id)).toBeNull();
  expect(await attached(dark.id)).toBeNull();
  expect(await attached(newLogo.id)).not.toBeNull();
  expect(await attached(favicon.id)).not.toBeNull();

  // The hourly cleanup deletes the released ones, files and all, and keeps what's in use.
  await cleanup();
  expect(await prisma.media.count({ where: { id: { in: [logo.id, dark.id] } } })).toBe(0);
  expect(mediaKeys(logo).filter((key) => s3.objects.has(key))).toEqual([]);
  expect(mediaKeys(newLogo).every((key) => s3.objects.has(key))).toBe(true);
  expect(await get()).toMatchObject({ logo: { id: newLogo.id }, favicon: { id: favicon.id } });
});

test("two saves at once: the logo that wins is attached, the other released by the daily job", async () => {
  const [old, first, second] = [await uploaded(), await uploaded(), await uploaded()];
  await update({ logo: old.id });
  await Promise.all([update({ logo: first.id }), update({ logo: second.id })]);
  const winner = (await get()).logo!.id;
  const loser = winner === first.id ? second.id : first.id;
  expect(await attached(winner)).not.toBeNull();
  await releaseADayLater();
  expect(await attached(winner)).not.toBeNull();
  expect(await attached(loser)).toBeNull();
  expect(await attached(old.id)).toBeNull();
});

test("a replaced logo can be picked again before the daily job runs", async () => {
  const [logo, other] = [await uploaded(), await uploaded()];
  await update({ logo: logo.id });
  await update({ logo: other.id });
  expect(await update({ logo: logo.id })).toMatchObject({ logo: { id: logo.id } });
  await releaseADayLater();
  expect(await attached(logo.id)).not.toBeNull();
  expect(await attached(other.id)).toBeNull();
});

test("a replaced logo that a post uses stays", async () => {
  const [logo, newLogo] = [await uploaded(), await uploaded()];
  await update({ logo: logo.id });
  await prisma.post.create({
    data: {
      projectId: project.id,
      boardId: project.boards[0]!.id,
      authorId: owner.id,
      number: 1,
      title: "With the old logo",
      content: { type: "doc", content: [{ type: "image", attrs: { mediaId: logo.id, width: "100", align: "center", alt: "", w: 480, h: 320 } }] },
    },
  });
  await update({ logo: newLogo.id });
  await releaseADayLater();
  expect(await attached(logo.id)).not.toBeNull();
});

test("one image may be both logos; it's released only once neither uses it", async () => {
  const logo = await uploaded();
  await update({ logo: logo.id, logoDark: logo.id });
  await update({ logoDark: null });
  await releaseADayLater();
  expect(await attached(logo.id)).not.toBeNull();
  await update({ logo: null });
  await releaseADayLater();
  expect(await attached(logo.id)).toBeNull();
});

test("another project's branding is its own", async () => {
  const other = await createProject(owner);
  await update({ color: "#5b21b6", poweredBy: false, licenseKey: issueLicense(project.id), headerLinks: [{ label: "Docs", url: "https://docs.example.com" }] });
  expect(await call(getBranding, team(other.id), {})).toMatchObject({ color: null, poweredBy: true, licensedUntil: null, headerLinks: [] });
});

test('"Powered by tuti" stays without a licence key for the project, however it was turned off', async () => {
  const needsLicence = { status: 400, message: 'Hiding "Powered by tuti" needs a licence key for this project' };
  await expect(update({ poweredBy: false })).rejects.toMatchObject(needsLicence);
  const wrongKey = { status: 400, message: "That licence key isn't for this project, or it has expired" };
  const other = await createProject(owner);
  await expect(update({ poweredBy: false, licenseKey: issueLicense(other.id) })).rejects.toMatchObject(wrongKey);
  await expect(update({ poweredBy: false, licenseKey: issueLicense(project.id, -1) })).rejects.toMatchObject(wrongKey);
  await expect(update({ licenseKey: "not-a-key" })).rejects.toMatchObject(wrongKey);
  expect(await get()).toMatchObject({ poweredBy: true, licensedUntil: null });

  // Turned off in the database, or with a key that has since expired: the portal still says it.
  await prisma.project.update({ where: { id: project.id }, data: { poweredBy: false } });
  expect(await get()).toMatchObject({ poweredBy: true });
  await prisma.project.update({ where: { id: project.id }, data: { licenseKey: issueLicense(project.id, -1) } });
  expect(await get()).toMatchObject({ poweredBy: true, licensedUntil: null });
  await prisma.project.update({ where: { id: project.id }, data: { licenseKey: issueLicense(other.id) } });
  expect(await get()).toMatchObject({ poweredBy: true, licensedUntil: null });
});

test("with a licence key, admins hide it until the key expires or is removed", async () => {
  const saved = await update({ poweredBy: false, licenseKey: issueLicense(project.id, 30) });
  expect(saved.poweredBy).toBe(false);
  expect(saved.licensedUntil!.getTime()).toBeGreaterThan(Date.now() + 29 * DAY);
  // The key stays: later saves don't need it again.
  expect(await update({ poweredBy: true })).toMatchObject({ poweredBy: true });
  expect(await update({ poweredBy: false })).toMatchObject({ poweredBy: false });
  expect(await update({ licenseKey: null })).toMatchObject({ poweredBy: true, licensedUntil: null });
  await expect(update({ poweredBy: false })).rejects.toMatchObject({ status: 400 });
});

test("the app's form saves everything: an empty image field removes it, empty link rows are skipped", async () => {
  actAs(owner);
  const logo = await uploaded();
  const form = (fields: Record<string, string>, rows: [string, string][] = []) => {
    const data = new FormData();
    for (const [name, value] of Object.entries(fields)) {
      data.set(name, value);
    }
    for (const [label, url] of rows) {
      data.append("headerLinkLabel", label);
      data.append("headerLinkUrl", url);
    }
    return data;
  };
  expect(
    await saveBranding(project.slug, {}, form({ logo: logo.id, logoDark: "", favicon: "", color: "#5b21b6", poweredBy: "on" }, [
      ["Docs", "https://docs.example.com"],
      ["", ""],
    ])),
  ).toEqual({});
  expect(await get()).toMatchObject({ logo: { id: logo.id }, color: "#5b21b6", headerLinks: [{ label: "Docs" }], footerLinks: [], poweredBy: true });

  // An unchecked checkbox isn't sent: Powered by is off, which needs the licence key (kept once saved).
  expect(await saveBranding(project.slug, {}, form({ logo: "", color: "#5b21b6" }))).toEqual({
    error: 'Hiding "Powered by tuti" needs a licence key for this project',
  });
  expect(await saveBranding(project.slug, {}, form({ logo: "", color: "#5b21b6", licenseKey: ` ${issueLicense(project.id)} ` }))).toEqual({});
  expect(await get()).toMatchObject({ logo: null, headerLinks: [], poweredBy: false, licensedUntil: expect.any(Date) });
  expect(await saveBranding(project.slug, {}, form({ color: "#5b21b6", licenseKey: "" }))).toEqual({});
  expect(await get()).toMatchObject({ poweredBy: false, licensedUntil: expect.any(Date) });
  await releaseADayLater();
  expect(await attached(logo.id)).toBeNull();
  expect(await saveBranding(project.slug, {}, form({ color: "#5b21b6" }, [["Docs", ""]]))).toEqual({ error: "Links need a full https:// address" });
});

test("branding is a project setting: members can't change it, admins can", async () => {
  const form = () => {
    const data = new FormData();
    data.set("color", "#5b21b6");
    data.set("poweredBy", "on");
    return data;
  };
  actAs(await addMember(project.id, "MEMBER"));
  expect(await saveBranding(project.slug, {}, form())).toEqual({ error: "Only project owners and admins can change the branding" });
  expect(await get()).toMatchObject({ color: null, poweredBy: true });

  actAs(await addMember(project.id, "ADMIN"));
  expect(await saveBranding(project.slug, {}, form())).toEqual({});
  expect(await get()).toMatchObject({ color: "#5b21b6" });
});

test("links stored some other way never reach the portal unless they're valid", async () => {
  await prisma.project.update({ where: { id: project.id }, data: { headerLinks: [{ label: "Bad", url: "javascript:alert(1)" }], footerLinks: "nope" } });
  expect(await get()).toMatchObject({ headerLinks: [], footerLinks: [] });
});

test("the colour becomes the accent, with readable text on it; where it's too faint, the accent is the text colour", () => {
  expect(brandCss(null)).toBeNull();
  const theme = "--primary:var(--foreground);--primary-foreground:var(--background);--ring:var(--foreground)";
  // A blue reads on both backgrounds, with white text on it.
  expect(brandCss("#2563eb")).toBe(
    "html:not(.dark){--primary:#2563eb;--primary-foreground:#ffffff;--ring:#2563eb}html.dark{--primary:#2563eb;--primary-foreground:#ffffff;--ring:#2563eb}",
  );
  // A pale yellow is lost on the light page, fine on the dark one (with black text).
  expect(brandCss("#fde047")).toBe(`html:not(.dark){${theme}}html.dark{--primary:#fde047;--primary-foreground:#000000;--ring:#fde047}`);
  // A navy is the other way round.
  expect(brandCss("#172554")).toBe(`html:not(.dark){--primary:#172554;--primary-foreground:#ffffff;--ring:#172554}html.dark{${theme}}`);
});
