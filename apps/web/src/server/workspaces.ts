"use server";

import { Prisma, prisma } from "@tuti/db";
import { redirect } from "next/navigation";
import { z } from "zod";

import type { FormState } from "./form-state";
import { getSession } from "./session";

// Top-level routes a workspace slug must not shadow.
const RESERVED_SLUGS = new Set(["api", "sign-in", "sign-up", "settings", "admin"]);

const createWorkspaceSchema = z.object({
  name: z.string().trim().min(2).max(60),
  slug: z
    .string()
    .trim()
    .toLowerCase()
    .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "Use lowercase letters, numbers and dashes")
    .min(2)
    .max(40)
    .refine((slug) => !RESERVED_SLUGS.has(slug), "That URL is reserved"),
});

export async function createWorkspace(_prev: FormState, formData: FormData): Promise<FormState> {
  const session = await getSession();
  if (!session) {
    return { error: "Sign in to create a workspace" };
  }

  const parsed = createWorkspaceSchema.safeParse({
    name: formData.get("name"),
    slug: formData.get("slug"),
  });
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }

  try {
    await prisma.workspace.create({
      data: {
        name: parsed.data.name,
        slug: parsed.data.slug,
        members: { create: { userId: session.user.id, role: "OWNER" } },
        boards: { create: { slug: "feature-requests", name: "Feature requests" } },
      },
    });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      return { error: "That URL is already taken" };
    }
    throw error;
  }

  redirect(`/${parsed.data.slug}/feature-requests`);
}
