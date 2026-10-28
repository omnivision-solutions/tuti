import { mediaKeys } from "@tuti/content/media";
import { prisma } from "@tuti/db";
import { handlers } from "@tuti/jobs";
import { type S3Fake, startS3Fake } from "@tuti/testkit";
import { afterAll, afterEach, beforeAll, beforeEach, expect, test, vi } from "vitest";
import type { z } from "zod";

import { GET } from "@/app/api/widget/latest/route";
import { createProject, signUp, type TestUser } from "@/test/helpers";

import { lastingImage } from "./media-urls";
import { call } from "./operations/run";
import { getWidgetSettings, updateWidgetSettings } from "./operations/widget";

/**
 * The widget launcher's icon: where plans are sold, picking one other than the chat bubble (or an image)
 * is on Pro. On a lower plan the one picked is kept but the launcher shows the chat bubble until the plan is back.
 */

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
  vi.stubEnv("PLANS", "on");
  owner = await signUp("Owner");
  project = await createProject(owner);
});
afterEach(() => vi.unstubAllEnvs());

const DAY = 24 * 60 * 60 * 1000;
const team = () => ({ actor: { kind: "user" as const, userId: owner.id }, projectId: project.id });
const update = (input: z.input<typeof updateWidgetSettings.input>) => call(updateWidgetSettings, team(), input);
const onPlan = (plan: "FREE" | "PRO") => prisma.project.update({ where: { id: project.id }, data: { plan } });
/** What the script on customers' sites is told about the launcher's icon. */
const served = async () => {
  const response = await GET(new Request(`http://tuti.localhost:3100/api/widget/latest?project=${project.slug}`));
  const { launcher } = (await response.json()) as { launcher: { icon: string; iconUrl: string | null } };
  return { icon: launcher.icon, iconUrl: launcher.iconUrl };
};

/** A processed upload of the project's, made two days ago, with its files in storage. */
async function uploaded(projectId = project.id) {
  const media = await prisma.media.create({
    data: { projectId, uploaderId: owner.id, size: 10, status: "READY", width: 256, height: 256, createdAt: new Date(Date.now() - 2 * DAY) },
  });
  for (const key of mediaKeys(media)) {
    s3.objects.set(key, { body: Buffer.from("x"), contentType: "image/webp" });
  }
  return media;
}

test("on Free, picking an icon or an image is refused; the chat bubble always works; Pro picks any", async () => {
  const image = await uploaded();
  for (const input of [{ icon: "help" as const }, { icon: "image" as const, iconImage: image.id }]) {
    await expect(update(input)).rejects.toMatchObject({
      status: 402,
      code: "plan_required",
      message: "Choosing the launcher's icon needs the Pro plan. See Settings → Billing.",
    });
  }
  expect(await update({ icon: "chat", label: "Help" })).toMatchObject({ icon: "chat", label: "Help" });

  await onPlan("PRO");
  expect(await update({ icon: "megaphone" })).toMatchObject({ icon: "megaphone", iconImage: null });
  expect(await served()).toEqual({ icon: "megaphone", iconUrl: null });
});

test("a project that drops to Free keeps its icon, but the launcher shows the chat bubble until the plan is back", async () => {
  await onPlan("PRO");
  const image = await uploaded();
  await update({ icon: "image", iconImage: image.id });
  const url = lastingImage(image)!.url;
  expect(await served()).toEqual({ icon: "image", iconUrl: url });

  await onPlan("FREE");
  expect(await call(getWidgetSettings, team(), {})).toMatchObject({ icon: "image", iconImage: { id: image.id, url } });
  expect(await served()).toEqual({ icon: "chat", iconUrl: null });
  // Other settings still save, and the icon stays as it was.
  expect(await update({ label: "Ideas", color: "#5b21b6" })).toMatchObject({ label: "Ideas", icon: "image", iconImage: { id: image.id } });
  // So does sending the icon it has: only a new one needs the plan.
  expect(await update({ icon: "image", iconImage: image.id, label: "Help" })).toMatchObject({ label: "Help", icon: "image" });

  await onPlan("PRO");
  expect(await served()).toEqual({ icon: "image", iconUrl: url });

  // On Free again, back to the chat bubble, with the form's image field still holding the old upload: the image goes.
  await onPlan("FREE");
  // Back to the chat bubble, with the form's image field still holding the old upload: the image goes.
  expect(await update({ icon: "chat", iconImage: image.id })).toMatchObject({ icon: "chat", iconImage: null });
});

test("removing an image icon's image goes back to the chat bubble", async () => {
  await onPlan("PRO");
  const image = await uploaded();
  await update({ icon: "image", iconImage: image.id });
  expect(await update({ iconImage: null })).toMatchObject({ icon: "chat", iconImage: null });
  // Picking the image icon without an image is still refused.
  await expect(update({ icon: "image", iconImage: null })).rejects.toMatchObject({ status: 400, message: "Upload an image for the icon" });
});

test("without plans (self-hosted), every project picks its icon", async () => {
  vi.stubEnv("PLANS", "");
  expect(await update({ icon: "lightbulb" })).toMatchObject({ icon: "lightbulb" });
  expect(await served()).toEqual({ icon: "lightbulb", iconUrl: null });
});

test("an uploaded icon is attached while it's used; another project's upload is refused; a replaced one is released", async () => {
  await onPlan("PRO");
  const other = await createProject(owner);
  await expect(update({ icon: "image", iconImage: (await uploaded(other.id)).id })).rejects.toMatchObject({ status: 409, code: "media_gone" });

  const image = await uploaded();
  await update({ icon: "image", iconImage: image.id });
  const attachedAt = async () => (await prisma.media.findUniqueOrThrow({ where: { id: image.id } })).attachedAt;
  expect(await attachedAt()).not.toBeNull();
  // A day later, still in use: kept.
  const releaseADayLater = async () => {
    await prisma.media.updateMany({ where: { projectId: project.id, attachedAt: { not: null } }, data: { attachedAt: new Date(Date.now() - 2 * DAY) } });
    await handlers.releaseMedia({}, { info: () => {}, warn: () => {} });
  };
  await releaseADayLater();
  expect(await attachedAt()).not.toBeNull();

  // Back to a built-in icon: the image goes with it, and is released.
  expect(await update({ icon: "help" })).toMatchObject({ icon: "help", iconImage: null });
  await releaseADayLater();
  expect(await attachedAt()).toBeNull();
});
