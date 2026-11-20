import { z } from "zod";

/** This server's own portal and widget, on the app's domain (Tuti's help center at tuti.so/help, its chat in the team app). */
export const ownPortal = z
  .strictObject({
    project: z
      .string()
      .describe(
        "The project whose portal is under a path of the app's domain, the path being its slug (\"help\": /help/docs). Its slug may be a reserved one, like help (not one of the app's own paths, like api); empty: none",
      )
      .default(""),
    owner: z.string().describe("The only address (verified) that can create `ownPortal.project`'s project; it also gets told when a project's email is paused. Empty: nobody").default(""),
    widgetProject: z.string().describe("A project whose widget shows in the team app (never on portals); with SSO on there, it signs people in with their account. Empty: none").default(""),
  })
  .prefault({});

/** The variables this section replaced: setting one stops start-up (checkConfig). */
export const OWN_PORTAL_REPLACED = {
  APP_PORTAL_PROJECT: "ownPortal.project",
  APP_PORTAL_OWNER: "ownPortal.owner",
  APP_WIDGET_PROJECT: "ownPortal.widgetProject",
};
