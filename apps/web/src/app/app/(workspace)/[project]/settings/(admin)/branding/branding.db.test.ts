import { prisma } from "@tuti/db";
import { billingFile } from "@tuti/testkit";
import { Children, isValidElement, type ReactElement, type ReactNode } from "react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

import { PoweredBySettings } from "@/components/branding-settings";
import { actAs, createProject, signUp } from "@/test/helpers";

import BrandingPage from "./page";

let slug: string;
let projectId: string;
beforeEach(async () => {
  const owner = await signUp("Owner");
  ({ slug, id: projectId } = await createProject(owner));
  actAs(owner);
});
afterEach(() => vi.unstubAllEnvs());

/** The element `type` in a tree of React elements, as the page returns it (nothing rendered). */
function find(node: ReactNode, type: unknown): ReactElement<Record<string, unknown>> | null {
  if (!isValidElement<{ children?: ReactNode }>(node)) {
    return null;
  }
  if (node.type === type) {
    return node as ReactElement<Record<string, unknown>>;
  }
  for (const child of Children.toArray(node.props.children)) {
    const found = find(child, type);
    if (found) {
      return found;
    }
  }
  return null;
}

/** What "Powered by tuti" is told hiding it costs on the project's plan. */
const offered = async () => {
  const page = await BrandingPage({ params: Promise.resolve({ project: slug }) } as PageProps<"/app/[project]/settings/branding">);
  return (find(page, PoweredBySettings)!.props.plan as { perMonth: number | null }).perMonth;
};

test("Powered by tuti quotes the add-on as billed on the project's plan, or what it starts at on the default plan", async () => {
  vi.stubEnv("BILLING_CONFIG", billingFile(({ badge }) => { badge!.year!.perMonth = 39; }));
  expect(await offered()).toBe(49);
  await prisma.project.update({ where: { id: projectId }, data: { plan: "pro", planInterval: "year" } });
  expect(await offered()).toBe(39);
  // Not sold for a yearly plan: no price.
  vi.stubEnv("BILLING_CONFIG", billingFile(({ badge }) => { delete badge!.year; }));
  expect(await offered()).toBeNull();
});
