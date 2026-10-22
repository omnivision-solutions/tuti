"use client";

import { useState } from "react";

import { ImageField, useBrandingForm } from "@/components/branding-settings";
import { CustomizeSection, usePreview } from "@/components/customize-shell";
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";

type Image = { id: string; url: string } | null;

/** Customize → SEO: the portal's title, description and share image in search results and links to it (see branding.update's seo and seoImage). */
export function SeoSettings({
  projectSlug,
  title,
  description,
  image,
  titleMax,
  descriptionMax,
}: {
  projectSlug: string;
  title: string;
  description: string;
  image: Image;
  titleMax: number;
  descriptionMax: number;
}) {
  const [uploading, setUploading] = useState(0);
  const [length, setLength] = useState(description.length);
  const text = (data: FormData, name: string) => String(data.get(name) ?? "");
  const { state, form } = useBrandingForm(
    projectSlug,
    "SEO saved",
    (data) => ({ seo: { title: text(data, "seoTitle").trim(), description: text(data, "seoDescription").trim(), image: text(data, "seoImageUrl") || null } }),
    uploading > 0,
  );
  return (
    <form {...form} className="flex flex-col gap-6">
      <input type="hidden" name="part" value="seo" />
      <CustomizeSection title="Search results" description="How your portal shows on search engines and where it's shared.">
        <FieldGroup>
          <Field>
            <FieldLabel htmlFor="seo-title">Page title</FieldLabel>
            <Input id="seo-title" name="seoTitle" defaultValue={title} maxLength={titleMax} placeholder="Your project's name" autoComplete="off" />
            <FieldDescription>In browser tabs and search results. 50 to 60 characters works best.</FieldDescription>
          </Field>
          <Field>
            <FieldLabel htmlFor="seo-description">Meta description</FieldLabel>
            <Textarea
              id="seo-description"
              name="seoDescription"
              defaultValue={description}
              maxLength={descriptionMax}
              rows={3}
              onChange={(event) => setLength(event.target.value.length)}
            />
            <FieldDescription className="flex justify-between gap-2">
              <span>Under the title in search results.</span>
              <span>
                {length}/{descriptionMax}
              </span>
            </FieldDescription>
          </Field>
        </FieldGroup>
      </CustomizeSection>
      <CustomizeSection title="Share image" description="Shown with links to your portal. 1200×630 pixels works best.">
        <ImageField
          projectSlug={projectSlug}
          name="seoImage"
          label="Share image"
          description="PNG, JPEG, WebP or GIF."
          image={image}
          look="light"
          onBusy={(delta) => setUploading((count) => count + delta)}
        />
      </CustomizeSection>
      {state.error && <FieldError>{state.error}</FieldError>}
    </form>
  );
}

/** SEO's preview: the portal as a search result and as a shared link, as the team sets it. */
export function SeoPreview({ address, name, saved }: { address: string; name: string; saved: { title: string; description: string; image: string | null } }) {
  const { draft } = usePreview();
  const seo = draft.seo ?? saved;
  const title = seo.title || name;
  const host = address.replace(/^https?:\/\//, "");
  return (
    <div className="mx-auto flex w-full max-w-xl flex-col gap-6">
      <figure aria-label="Search result preview" className="flex flex-col gap-2">
        <figcaption className="text-sm font-medium text-muted-foreground">In search results</figcaption>
        <div className="flex flex-col gap-1 rounded-xl border bg-background p-5 shadow-sm">
          <span className="truncate text-xs text-muted-foreground">{host}</span>
          <span className="text-lg break-words text-primary">{title}</span>
          <span className="line-clamp-2 text-sm break-words text-muted-foreground">{seo.description || "Search engines pick a line from the page."}</span>
        </div>
      </figure>
      <figure aria-label="Shared link preview" className="flex flex-col gap-2">
        <figcaption className="text-sm font-medium text-muted-foreground">Shared as a link</figcaption>
        <div className="overflow-hidden rounded-xl border bg-background shadow-sm">
          {seo.image ? (
            // eslint-disable-next-line @next/next/no-img-element -- served from the media host, already resized
            <img src={seo.image} alt="" className="aspect-[1200/630] w-full object-cover" />
          ) : (
            <div className="flex aspect-[1200/630] w-full items-center justify-center bg-muted text-sm text-muted-foreground">No share image</div>
          )}
          <div className="flex flex-col gap-0.5 border-t p-4">
            <span className="truncate text-xs text-muted-foreground uppercase">{host}</span>
            <span className="font-semibold break-words">{title}</span>
            {seo.description && <span className="line-clamp-2 text-sm break-words text-muted-foreground">{seo.description}</span>}
          </div>
        </div>
      </figure>
    </div>
  );
}
