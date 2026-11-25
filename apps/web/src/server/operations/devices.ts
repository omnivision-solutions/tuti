import { prisma } from "@tuti/db";
import { z } from "zod";

import { type Actor, defineOperation, OperationError } from "./define";

/**
 * The mobile app's push notifications (docs/plan.md, Mobile app; packages/jobs push.ts): a teammate's phones, across
 * all their projects (each notification names its project), and whether a notification shows the message's text.
 * A person's own, so API keys are refused, except for reading the setting (as the key's creator's).
 */

/** The caller as a person, or the 403 an API key gets. */
function person(actor: Actor, doing: string) {
  if (actor.kind !== "user") {
    throw new OperationError(403, "people_only", `Only a signed-in teammate ${doing}`);
  }
  return actor;
}

const notificationSettings = z
  .object({
    showMessageText: z
      .boolean()
      .describe("Whether a notification shows the message's text; off, it says who wrote and in which project, not what")
      .meta({ examples: [true] }),
  })
  .describe("Your phone notifications' settings, for all your projects");

const settingsOf = (userId: string) =>
  prisma.user.findUniqueOrThrow({ where: { id: userId }, select: { pushShowsText: true } }).then((user) => ({ showMessageText: user.pushShowsText }));

export const registerDevice = defineOperation({
  name: "devices.register",
  title: "Register a device",
  summary:
    "Register the phone Tuti's app is on for notifications, or refresh it: it's told when a user writes if you'd get the email, in any of your projects, until you sign out of the app. The same `deviceId` again replaces it. People only: API keys get 403.",
  method: "POST",
  path: "/devices",
  scope: "write",
  access: "team",
  input: z.object({
    deviceId: z
      .string()
      .min(1)
      .max(200)
      .describe("An id the app made up for this install and keeps, so registering again replaces rather than adds")
      .meta({ examples: ["3f1c9a7e-2b4d-4e8a-9c61-5d0f7b2a8e34"] }),
    token: z
      .string()
      .max(200)
      .regex(/^Expo(nent)?PushToken\[[^\]\s]+\]$/, "An Expo push token: ExponentPushToken[…]")
      .describe("The device's Expo push token")
      .meta({ examples: ["ExponentPushToken[xxxxxxxxxxxxxxxxxxxxxx]"] }),
    platform: z.enum(["ios", "android"]).describe("The device's platform"),
  }),
  example: { deviceId: "3f1c9a7e-2b4d-4e8a-9c61-5d0f7b2a8e34", token: "ExponentPushToken[xxxxxxxxxxxxxxxxxxxxxx]", platform: "ios" },
  output: z.object({ deviceId: z.string().describe("The device's id, as sent").meta({ examples: ["3f1c9a7e-2b4d-4e8a-9c61-5d0f7b2a8e34"] }) }).describe("The device registered"),
  run: async ({ actor }, { deviceId, token, platform }) => {
    const { userId, sessionId } = person(actor, "registers a device");
    if (!sessionId) {
      throw new OperationError(403, "app_only", "Register a device from Tuti's app, with its session");
    }
    await prisma.$transaction(async (tx) => {
      // One registration of a token at a time: two at once would each miss the other's new row and both stay.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(13, hashtext(${token}))`;
      await tx.device.upsert({
        where: { userId_deviceId: { userId, deviceId } },
        create: { userId, deviceId, token, platform, sessionId },
        update: { token, platform, sessionId, lastSeenAt: new Date() },
      });
      // A phone is one account's at a time: whoever's app registered it last. Every other row with this token goes,
      // their own (a reinstall whose id was lost) and another account's (signed out while offline, then someone else
      // signed in), so none is left to fall back to when this one's session ends. The other gets the phone back when
      // their app opens and registers again.
      await tx.device.deleteMany({ where: { token, NOT: { userId, deviceId } } });
    });
    return { deviceId };
  },
});

export const removeDevice = defineOperation({
  name: "devices.remove",
  title: "Remove a device",
  summary: "Stop notifications on one of your phones, by the `deviceId` it registered with (signing out of the app stops them too). People only: API keys get 403.",
  method: "DELETE",
  path: "/devices/{deviceId}",
  scope: "write",
  access: "team",
  input: z.object({ deviceId: z.string().min(1).max(200).describe("The id the app registered the device with").meta({ examples: ["3f1c9a7e-2b4d-4e8a-9c61-5d0f7b2a8e34"] }) }),
  output: z.object({ removed: z.boolean().describe("Whether there was such a device of yours").meta({ examples: [true] }) }).describe("The device removed"),
  run: async ({ actor }, { deviceId }) => {
    const { userId } = person(actor, "removes a device");
    const { count } = await prisma.device.deleteMany({ where: { userId, deviceId } });
    return { removed: count > 0 };
  },
});

export const getNotificationSettings = defineOperation({
  name: "notifications.get",
  title: "Get notification settings",
  summary: "Read your settings for notifications on your phones, which hold in all your projects. For an API key, its creator's.",
  method: "GET",
  path: "/notifications",
  scope: "read",
  access: "team",
  input: z.object({}),
  output: notificationSettings,
  run: ({ actor }) => settingsOf(actor.kind === "user" ? actor.userId : actor.createdById),
});

export const updateNotificationSettings = defineOperation({
  name: "notifications.update",
  title: "Set notification settings",
  summary: "Change your settings for notifications on your phones, in all your projects. What's left out stays as it was. People only: API keys get 403.",
  method: "PATCH",
  path: "/notifications",
  scope: "write",
  access: "team",
  input: z.object({ showMessageText: notificationSettings.shape.showMessageText.optional() }),
  example: { showMessageText: false },
  output: notificationSettings,
  run: async ({ actor }, { showMessageText }) => {
    const { userId } = person(actor, "changes their notifications");
    if (showMessageText !== undefined) {
      await prisma.user.update({ where: { id: userId }, data: { pushShowsText: showMessageText } });
    }
    return settingsOf(userId);
  },
});
