"use server";

import { Prisma, prisma } from "@tuti/db";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";

import { isReservedSlug, SLUG_PATTERN } from "@/lib/project-slugs";

import type { FormState } from "./form-state";
import { getAccountSession } from "./session";

const createProjectSchema = z.object({
  name: z.string().trim().min(2).max(60),
  slug: z
    .string()
    .trim()
    .toLowerCase()
    .regex(SLUG_PATTERN, "Use lowercase letters, numbers and single dashes")
    .min(2)
    .max(40)
    .refine((slug) => !isReservedSlug(slug), "That URL is reserved"),
});

export async function createProject(_prev: FormState, formData: FormData): Promise<FormState> {
  const session = await getAccountSession();
  if (!session) {
    return { error: "Sign in to create a project" };
  }

  const parsed = createProjectSchema.safeParse({
    name: formData.get("name"),
    slug: formData.get("slug"),
  });
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }

  try {
    await prisma.project.create({
      data: {
        name: parsed.data.name,
        slug: parsed.data.slug,
        team: { create: { userId: session.user.id, role: "OWNER" } },
        boards: { create: { slug: "feature-requests", name: "Feature requests" } },
      },
    });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      return { error: "That URL is already taken" };
    }
    throw error;
  }

  // The /app layout lists your projects; refresh it before navigating.
  revalidatePath("/app", "layout");
  redirect(`/app/${parsed.data.slug}`);
}
