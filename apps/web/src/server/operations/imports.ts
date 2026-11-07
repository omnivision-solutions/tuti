import { type ImportSource, prisma, type Prisma } from "@tuti/db";
import { continueImport, failStaleImports, type ImportCounts, IMPORT_KEY, IMPORT_SOURCES as SOURCES, type ImportSourceDefinition, importStale, importStuck, lockProject, nextStep, resumeImport } from "@tuti/jobs";
import { boardLimit, log } from "@tuti/shared";
import { sealValue } from "@tuti/shared/signed";
import { z } from "zod";

import { IMPORT_PARTS, IMPORT_SOURCES, type ImportPart, type ImportSourceInfo, type ImportSourceKey, missingNeed } from "@/lib/import-parts";

import { defineOperation, OperationError } from "./define";

/**
 * Imports from another tool (docs/plan.md, Switching from Featurebase): the first run's "Where are you coming from?"
 * starts one with the tool's API key and the parts picked, and shows its progress. It runs in the background, a page at
 * a time (@tuti/jobs imports.ts); the key is kept only while it runs.
 */

const importSelect = {
  id: true,
  projectId: true,
  source: true,
  parts: true,
  state: true,
  step: true,
  counts: true,
  error: true,
  createdAt: true,
  updatedAt: true,
  finishedAt: true,
  startedBy: { select: { name: true } },
} satisfies Prisma.DataImportSelect;

type ImportRow = Prisma.DataImportGetPayload<{ select: typeof importSelect }>;

/** An import as the API and the app show it (never its key). */
async function importView(row: ImportRow) {
  return {
    id: row.id,
    source: row.source.toLowerCase() as ImportSourceKey,
    /** running, done, or failed (`error` says why; started again, what came across already is skipped). */
    state: row.state.toLowerCase() as "running" | "done" | "failed",
    parts: row.parts as ImportPart[],
    /** The step under way (contacts, …), while it runs; where it stopped, once failed. */
    step: row.state === "DONE" ? null : row.step || null,
    /** What came across so far, per kind: how many, and how many it left out, by reason. */
    counts: row.counts as ImportCounts,
    error: row.error || null,
    startedBy: row.startedBy?.name ?? null,
    createdAt: row.createdAt.toISOString(),
    finishedAt: row.finishedAt?.toISOString() ?? null,
    /** The invitations an import (this one or an earlier one) left waiting to be sent, as Team & roles lists them. */
    invitationsToSend: await prisma.invitation.count({ where: { projectId: row.projectId, sentAt: null, acceptedAt: null, revokedAt: null } }),
  };
}

export type ImportView = Awaited<ReturnType<typeof importView>>;

/** Inline (JOBS_DRIVER=inline), the import's pages go on without the request that started or looked at it waiting for them. */
const inBackground = () => ({ wait: process.env.JOBS_DRIVER !== "inline" });

/**
 * The project's latest import (null: none yet); a stuck one (its job went away) goes on here, and one that hasn't moved
 * for a day is failed, its key cleared, as the daily fail-stale-imports would (inline installs run no scheduled jobs).
 */
export async function latestImport(projectId: string): Promise<ImportView | null> {
  const latest = await prisma.dataImport.findFirst({ where: { projectId }, orderBy: [{ createdAt: "desc" }, { id: "desc" }], select: importSelect });
  if (!latest || !importStuck(latest)) {
    return latest && (await importView(latest));
  }
  if (importStale(latest)) {
    await failStaleImports();
  } else {
    await resumeImport(latest.id, log, inBackground());
  }
  return importView(await prisma.dataImport.findUniqueOrThrow({ where: { id: latest.id }, select: importSelect }));
}

/** What a Featurebase import does past the plan's board limit (its boards come turned off), and the plan that has room (null: no limit). */
export function boardsNote(plan: "FREE" | "PRO" | "BUSINESS"): string | null {
  const limit = boardLimit(plan);
  if (limit === null) {
    return null;
  }
  const more = plan === "FREE" ? `Pro has up to ${boardLimit("PRO")}, and Business any number.` : "Business has any number.";
  return `Projects on the ${plan === "FREE" ? "free" : "Pro"} plan have up to ${limit} feedback boards: Featurebase's boards past that come across turned off, seen only by your team in the app until an upgrade lets you turn them on. ${more}`;
}

const label = (part: ImportPart) => IMPORT_PARTS[part].label;

/** How long starting an import may spend asking the source (the key, then each part's list). */
export const START_CHECK_MS = 20_000;

/** The source's answer to a check, as the form says it: `cant` is what a refusal (401, 403) means. */
function refusal(source: ImportSourceDefinition, error: unknown, cant: { code: string; message: string }): never {
  const status = source.status(error);
  if (status === 401 || status === 403) {
    throw new OperationError(400, cant.code, cant.message);
  }
  if (status !== null && error instanceof Error) {
    throw new OperationError(502, "unavailable", status === 0 ? `${error.message} Try again in a moment.` : `${source.name} answered ${status} (${error.message}). Try again in a moment.`);
  }
  throw error;
}

export const startImport = defineOperation({
  name: "imports.start",
  summary:
    "Start an import from another tool (`source`: featurebase, with an API key of its own; intercom, with an app's access token) and the parts to bring, of those the source has (Featurebase: all of them; Intercom: contacts, docs and avatars; any other is 400) (contacts: as the project's users, by their id in your app; feedback: boards, posts, votes, comments and the team's private comments as notes, quietly, with their dates; docs: the help center's collections and articles, with their media and the links between them, published as they were; changelog: its entries, published at their dates or as drafts, with their images, quietly; avatars: contacts' uploaded profile pictures, copied last). Feedback and avatars need Contacts (400 without). The key is checked, then each part's list read once: a key the source refuses, or one that can't read a part, is refused (400, saying which). It runs in the background, a page at a time (imports.get shows its progress); the key is kept only while it runs. Started again later, it brings only what's new since (contacts, posts, votes, comments, changelog entries, articles, conversations and their new messages), nothing twice. Only people can start it, in the app (its first run, or Settings → Import): API keys and MCP get 403. One runs per project at a time: starting it again returns the one running",
  method: "POST",
  path: "/imports",
  scope: "write",
  access: "admin",
  // `key`: the source's API key, or its site's address (import-parts IMPORT_SOURCES' credential); `parts`: only those it has.
  input: z
    .object({
      source: z.enum(Object.keys(IMPORT_SOURCES) as [ImportSourceKey, ...ImportSourceKey[]]),
      key: z.string().trim().max(500),
      parts: z.array(z.enum(Object.keys(IMPORT_PARTS) as [ImportPart, ...ImportPart[]])).min(1, "Pick what to bring"),
    })
    .superRefine(({ source, key, parts }, ctx) => {
      const { name, credential, parts: has } = IMPORT_SOURCES[source] as ImportSourceInfo;
      if (credential.kind === "key" ? key === "" : !z.url({ protocol: /^https?$/ }).safeParse(key).success) {
        ctx.addIssue({ code: "custom", path: ["key"], message: credential.kind === "key" ? `Paste your ${name} API key` : `Paste your ${name} address` });
      }
      for (const part of parts.filter((p) => !has.includes(p))) {
        ctx.addIssue({ code: "custom", path: ["parts"], message: `${name} has no ${IMPORT_PARTS[part].label} to bring` });
      }
    }),
  run: async ({ actor, projectId }, input) => {
    // It takes another tool's key, pasted into the app.
    if (actor.kind !== "user") {
      throw new OperationError(403, "people_only", "Only a person can start an import, in the app.");
    }
    const parts = [...new Set(input.parts)];
    const missing = missingNeed(parts, IMPORT_PARTS);
    if (missing) {
      throw new OperationError(400, "needs_part", `${label(missing.part)} needs ${label(missing.need)}: pick it too.`);
    }
    const latest = await latestImport(projectId);
    if (latest?.state === "running") {
      return latest;
    }
    const sourceRow = input.source.toUpperCase() as ImportSource;
    const source = SOURCES[sourceRow];
    // Someone waits on "Checking the key…": a slow or rate-limited source is said at once, not waited out.
    const connection = source.connect(input.key, { deadline: Date.now() + START_CHECK_MS });
    await connection.checkCredential().catch((error: unknown) =>
      refusal(source, error, { code: "bad_key", message: `${source.name} didn't accept this API key. Check you copied all of it, or make a new one.` }),
    );
    for (const part of parts) {
      await connection.checks[part]!().catch((error: unknown) =>
        refusal(source, error, { code: "cant_read", message: `This key can't read ${label(part)} in ${source.name}. Use a key that can, or leave ${label(part)} out.` }),
      );
    }
    // Under the project's lock: two starts at once make one.
    const started = await prisma.$transaction(async (tx) => {
      await lockProject(tx, projectId);
      const running = await tx.dataImport.findFirst({ where: { projectId, state: "RUNNING" }, select: { id: true } });
      return (
        running ??
        (await tx.dataImport.create({
          data: { projectId, source: sourceRow, startedById: actor.userId, apiKey: sealValue(IMPORT_KEY, input.key), parts, step: nextStep(parts, null) ?? "" },
          select: { id: true },
        }))
      );
    });
    await continueImport(started.id, log, inBackground());
    return importView(await prisma.dataImport.findUniqueOrThrow({ where: { id: started.id }, select: importSelect }));
  },
});

export const getImport = defineOperation({
  name: "imports.get",
  summary: "The project's latest import (imports.start), running or ended, with what came across so far, per kind, and what it left out and why (null: none yet)",
  method: "GET",
  path: "/imports/latest",
  scope: "read",
  access: "admin",
  input: z.object({}),
  run: async ({ projectId }) => ({ import: await latestImport(projectId) }),
});
