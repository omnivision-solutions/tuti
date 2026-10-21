import { prisma } from "@tuti/db";
import { z } from "zod";

import { installation as thisInstallation, licensedUntil, licenseNow } from "../license";
import { renewLicense } from "../license-renewal";
import { defineOperation } from "./define";

/** The project's licence (hides "Powered by tuti"; see server/license.ts): until when, and what tuti.so last said. */

export const checkLicense = defineOperation({
  name: "license.check",
  summary:
    "Check tuti.so for the project's licence now (bought at tuti.so/license): status licensed, not_licensed (none yet, or cancelled), in_use (on another installation), unreachable (tuti.so didn't answer; the current key stays) or busy (just checked), and licensedUntil",
  method: "POST",
  path: "/license/check",
  scope: "write",
  access: "admin",
  input: z.object({}),
  run: async ({ projectId }) => {
    // From now on this project's licence is checked (daily, after portal pages) until it has one.
    await prisma.project.updateMany({ where: { id: projectId, licenseRequestedAt: null }, data: { licenseRequestedAt: new Date() } });
    const status = await renewLicense(projectId);
    const [project, installation] = await Promise.all([
      prisma.project.findUniqueOrThrow({ where: { id: projectId }, select: { licenseKey: true } }),
      thisInstallation(),
    ]);
    return {
      status,
      licensedUntil: licensedUntil(project.licenseKey, { installation: installation.id, project: projectId }, licenseNow(installation)),
    };
  },
});
