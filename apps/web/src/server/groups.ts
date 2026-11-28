"use server";

import { refresh } from "next/cache";

import type { PropertyFormats } from "@/lib/property-formats";

import { removeChangelogSubscribers } from "./operations/changelog-subscribers";
import { updateProject, updatePropertyFormats } from "./operations/more";
import { asAdmin, call } from "./operations/run";

/** Users' Columns: the properties the table shows, in order (see project.update's userColumns). */
export async function setUserColumns(projectSlug: string, columns: string[]): Promise<{ error?: string }> {
  return asAdmin(projectSlug, "Only project owners and admins can change Users' columns", (context) =>
    call(updateProject, context, { userColumns: Array.isArray(columns) ? columns.map(String) : [] }),
  );
}

/** Users → Subscribers' Remove: stops emailing the changelog to an address (changelogSubscribers.remove). */
export async function removeChangelogSubscriber(projectSlug: string, email: string): Promise<{ error?: string }> {
  const result = await asAdmin(projectSlug, "Only project owners and admins can remove subscribers", (context) =>
    call(removeChangelogSubscribers, context, { emails: [String(email)] }),
  );
  if (!result.error) {
    refresh();
  }
  return result;
}

/** Settings → Users → User properties: the team's name and format for one property, or a few, keeping the rest (propertyFormats.update). */
export async function setPropertyFormats(projectSlug: string, changes: PropertyFormats): Promise<{ error?: string }> {
  return asAdmin(projectSlug, "Only project owners and admins can change how properties show", (context) =>
    call(updatePropertyFormats, context, { formats: changes ?? {} }),
  );
}

