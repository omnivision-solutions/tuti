import { prisma } from "@tuti/db";
import { z } from "zod";

import { projectLicense } from "../license";
import { renewLicense } from "../license-renewal";
import { defineOperation } from "./define";

/** The project's licence (hides "Powered by tuti"; see server/license.ts): until when, and what tuti.so last said. */

export const checkLicense = defineOperation({
  name: "license.check",
  title: "Check the licence",
  summary: "Ask tuti.so about the project's licence now (bought at tuti.so/app/license), and keep it checked daily from then on.",
  method: "POST",
  path: "/license/check",
  scope: "write",
  access: "admin",
  input: z.object({}),
  output: z
    .object({
      status: z
        .enum(["licensed", "not_licensed", "in_use", "unreachable", "busy"])
        .describe(
          "What tuti.so said: licensed, not_licensed (none yet, or cancelled), in_use (on another installation), unreachable (tuti.so didn't answer; the current key stays) or busy (just checked)",
        )
        .meta({ examples: ["licensed"] }),
      licensedUntil: z.string().nullable().describe("Until when the project is licensed (ISO 8601), or null without a licence").meta({ examples: ["2027-11-19T00:00:00.000Z"] }),
    })
    .describe("The check's answer"),
  run: async ({ projectId }) => {
    // From now on this project's licence is checked (daily, after portal pages) until it has one.
    await prisma.project.updateMany({ where: { id: projectId, licenseRequestedAt: null }, data: { licenseRequestedAt: new Date() } });
    const status = await renewLicense(projectId);
    return { status, licensedUntil: (await projectLicense(projectId)).licensedUntil };
  },
});
