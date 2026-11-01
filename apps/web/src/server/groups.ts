"use server";

import { prisma } from "@tuti/db";
import { z } from "zod";

import { groupConditions } from "@/lib/group-conditions";
import { type PropertyFormats, storedPropertyFormats } from "@/lib/property-formats";

import type { FormState } from "./form-state";
import { getAdminProject } from "./membership";
import { createGroup, deleteGroup as deleteGroupOperation, matchingUsers, updateGroup } from "./operations/groups";
import { updateProject } from "./operations/more";
import { asAdmin, call } from "./operations/run";
import { getSession } from "./session";

/** Settings → Groups (see the groups.* operations). */

const DENIED = "Only project owners and admins can change the groups";

/** The conditions the dialog sends (JSON), checked by the operation: anything else is refused there. */
function conditionsFrom(formData: FormData): unknown {
  try {
    return JSON.parse(String(formData.get("conditions") ?? "[]"));
  } catch {
    return null;
  }
}

/** Adds a group (`key` null) or changes group `key`: its name, conditions and description. */
export async function saveGroup(projectSlug: string, key: string | null, _state: FormState, formData: FormData): Promise<FormState> {
  const input = {
    name: String(formData.get("name") ?? ""),
    description: String(formData.get("description") ?? ""),
    conditions: conditionsFrom(formData) as z.input<typeof groupConditions>,
  };
  return asAdmin(projectSlug, DENIED, (context) =>
    key === null ? call(createGroup, context, input) : call(updateGroup, context, { group: String(key), ...input }),
  );
}

export async function deleteGroup(projectSlug: string, key: string): Promise<FormState> {
  return asAdmin(projectSlug, DENIED, (context) => call(deleteGroupOperation, context, { group: String(key) }));
}

/** How many users the group dialog lists beside the conditions. */
const PREVIEW_USERS = 50;

export type GroupPreview = { readers: number; users: { id: string; name: string; email: string | null; avatar: string | null }[] };

/** The group dialog's preview: how many of the project's users a group with these conditions would have now, and the first 50. */
export async function previewGroup(projectSlug: string, conditions: z.input<typeof groupConditions>): Promise<{ error: string } | GroupPreview> {
  const [session, project] = await Promise.all([getSession(), getAdminProject(projectSlug)]);
  if (!session || !project) {
    return { error: DENIED };
  }
  const input = groupConditions.safeParse(conditions);
  if (!input.success) {
    return { error: input.error.issues[0]?.message ?? "Invalid input" };
  }
  return matchingUsers(project.id, input.data, PREVIEW_USERS);
}

/** Users' Columns: the properties the table shows, in order (see project.update's userColumns). */
export async function setUserColumns(projectSlug: string, columns: string[]): Promise<{ error?: string }> {
  return asAdmin(projectSlug, "Only project owners and admins can change Users' columns", (context) =>
    call(updateProject, context, { userColumns: Array.isArray(columns) ? columns.map(String) : [] }),
  );
}

/**
 * Settings → Access → User properties: the team's name and format for the properties it changed, on top of those kept now
 * (project.update's propertyFormats takes them all), so a page opened earlier doesn't undo what was saved since.
 */
export async function setPropertyFormats(projectSlug: string, changes: PropertyFormats): Promise<{ error?: string }> {
  return asAdmin(projectSlug, "Only project owners and admins can change how properties show", (context) =>
    // One save at a time per project (two admins at once each keep the other's rows): read, merge and write under a lock.
    // The write is project.update's own, on another connection; nothing it does waits for this lock.
    prisma.$transaction(
      async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(7, hashtext(${context.projectId}))`;
        const { propertyFormats } = await tx.project.findUniqueOrThrow({ where: { id: context.projectId }, select: { propertyFormats: true } });
        // fromEntries, so a property named "__proto__" is one like any other. The operation's input checks every name,
        // label, format and currency, whatever the browser sent; one cleared is dropped there.
        const formats = Object.fromEntries([...Object.entries(storedPropertyFormats(propertyFormats)), ...Object.entries(changes ?? {})]);
        return call(updateProject, context, { propertyFormats: formats });
      },
      { timeout: 15_000 },
    ),
  );
}

/** Settings → Access → Who's asking: the number property Feedback totals over a post's voters (null: none; see project.update). */
export async function setAskingProperty(projectSlug: string, property: string | null): Promise<{ error?: string }> {
  return asAdmin(projectSlug, "Only project owners and admins can change Who's asking", (context) =>
    call(updateProject, context, { askingProperty: property === null ? null : String(property) }),
  );
}
