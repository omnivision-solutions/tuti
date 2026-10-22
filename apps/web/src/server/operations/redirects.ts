import { prisma } from "@tuti/db";
import { lockProject } from "@tuti/jobs";
import { z } from "zod";

import { MAX_REDIRECTS, redirectFrom, redirectKey, redirectTo } from "@/lib/portal-redirects";

import { portalUrl } from "@/lib/hosts";

import { portalAddress } from "../custom-domains";
import { forgetRedirects } from "../portal-redirects";
import { projectSlug } from "./read";
import { defineOperation, OperationError } from "./define";

/** Customize → Redirects (lib/portal-redirects.ts): old addresses on the portal sent on to new ones (proxy.ts). */

const view = { id: true, from: true, to: true } as const;

/** `to` as a path of the portal when it's a whole address under one of the portal's `addresses`. */
function onPortal(to: string, addresses: string[]): string {
  if (!URL.canParse(to)) {
    return to;
  }
  const target = new URL(to);
  for (const address of addresses) {
    const portal = new URL(address);
    const base = portal.pathname.replace(/\/$/, "");
    if (target.origin === portal.origin && (target.pathname === base || target.pathname.startsWith(`${base}/`) || !base)) {
      return `${target.pathname.slice(base.length) || "/"}${target.search}`;
    }
  }
  return to;
}

export const listRedirects = defineOperation({
  name: "redirects.list",
  summary: "List the portal's redirects, newest first: each sends requests for `from` (a path of the portal) to `to` (a path of it, or a whole https address)",
  method: "GET",
  path: "/redirects",
  scope: "read",
  access: "team",
  input: z.object({}),
  run: async ({ projectId }) => ({ redirects: await prisma.portalRedirect.findMany({ where: { projectId }, orderBy: [{ createdAt: "desc" }, { id: "desc" }], select: view }) }),
});

export const createRedirect = defineOperation({
  name: "redirects.create",
  summary: `Send an old address on the portal on to a new one: \`from\` is the old path (or a whole URL of the old site, whose path is taken), matched lowercase whatever the query; \`to\` is a path of the portal or a whole https address, which gets the request's query unless it has its own. Not the portal's own addresses (sign-in, /api, /widget, …) or its home, one rule per \`from\`, no rule to or from another rule's address (so they can't go round in circles), up to ${MAX_REDIRECTS}`,
  method: "POST",
  path: "/redirects",
  scope: "write",
  access: "admin",
  input: z.object({ from: z.string().max(2000), to: z.string().max(2000) }),
  example: { from: "/hc/en-us/articles/123-billing", to: "/docs/billing" },
  run: async ({ projectId }, input) => {
    const from = redirectFrom(input.from);
    if ("error" in from) {
      throw new OperationError(400, "invalid_input", from.error);
    }
    // A whole address on this portal (its Tuti address, or its own) is a path of it: the checks below
    // then see where it goes, so it can't go round in circles.
    const slug = await projectSlug(projectId);
    const to = redirectTo(onPortal(input.to.trim(), [portalUrl(slug), await portalAddress(slug)]));
    if ("error" in to) {
      throw new OperationError(400, "invalid_input", to.error);
    }
    if (to.to.startsWith("/") && redirectKey(to.to.split("?")[0]!) === from.from) {
      throw new OperationError(400, "invalid_input", "A redirect can't send an address to itself");
    }
    const redirect = await prisma.$transaction(async (tx) => {
      // One change at a time per project: the checks below hold for the rule that's added.
      await lockProject(tx, projectId);
      const rules = await tx.portalRedirect.findMany({ where: { projectId }, select: { from: true, to: true } });
      if (rules.some((rule) => rule.from === from.from)) {
        throw new OperationError(409, "conflict", `${from.from} already has a redirect. Delete it first to change where it goes`);
      }
      if (rules.length >= MAX_REDIRECTS) {
        throw new OperationError(400, "invalid_input", `Up to ${MAX_REDIRECTS} redirects. Delete some you no longer need first`);
      }
      // No chains: they'd be one rule too many at best, and round in circles at worst.
      const target = to.to.startsWith("/") ? redirectKey(to.to.split("?")[0]!) : null;
      if ((target && rules.some((rule) => rule.from === target)) || rules.some((rule) => rule.to.startsWith("/") && redirectKey(rule.to.split("?")[0]!) === from.from)) {
        throw new OperationError(400, "invalid_input", "That address is already part of another redirect. Point both at where people should end up instead");
      }
      return tx.portalRedirect.create({ data: { projectId, from: from.from, to: to.to }, select: view });
    });
    forgetRedirects(slug);
    return { redirect };
  },
});

export const deleteRedirect = defineOperation({
  name: "redirects.delete",
  summary: "Stop a redirect (`id`, from redirects.list): its old address is the portal's again",
  method: "DELETE",
  path: "/redirects/{id}",
  scope: "write",
  access: "admin",
  input: z.object({ id: z.string() }),
  run: async ({ projectId }, input) => {
    const { count } = await prisma.portalRedirect.deleteMany({ where: { id: input.id, projectId } });
    if (count === 0) {
      throw new OperationError(404, "not_found", "There's no such redirect");
    }
    forgetRedirects(await projectSlug(projectId));
    return { deleted: input.id };
  },
});
