"use client";

import { ImageIcon, UploadIcon, XIcon } from "lucide-react";
import { useId, useRef, useState } from "react";

import { useBrandingForm, useImageUpload } from "@/components/branding-settings";
import { usePreview } from "@/components/customize-shell";
import { SettingBlock, SettingRow, SettingsCard } from "@/components/settings-card";
import { Button } from "@/components/ui/button";
import { FieldError } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";

type Image = { id: string; url: string } | null;

/**
 * Settings → Portal → SEO: the portal's title, description and share image in search results and links to it (see
 * branding.update's seo and seoImage), one row each in one card (docs/design.md → Settings rows).
 */
export function SeoSettings({
  projectSlug,
  name,
  title,
  description,
  image,
  titleMax,
  descriptionMax,
}: {
  projectSlug: string;
  /** The project's name: the page title when the team sets none, so the field's placeholder. */
  name: string;
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
    <form {...form} className="flex flex-col gap-4">
      <input type="hidden" name="part" value="seo" />
      <SettingsCard>
        <SettingRow label="Page title" htmlFor="seo-title">
          <Input id="seo-title" name="seoTitle" defaultValue={title} maxLength={titleMax} placeholder={name} autoComplete="off" />
        </SettingRow>
        {/* Not a SettingRow: the count sits at the label's right, the text under both at the card's width. */}
        <SettingBlock className="gap-2.5 py-3.5">
          <div className="flex items-baseline justify-between gap-3">
            <label htmlFor="seo-description" className="font-medium">
              Meta description
            </label>
            <span className="text-sm text-muted-foreground">
              {length}/{descriptionMax}
            </span>
          </div>
          <Textarea
            id="seo-description"
            name="seoDescription"
            defaultValue={description}
            maxLength={descriptionMax}
            rows={3}
            onChange={(event) => setLength(event.target.value.length)}
          />
        </SettingBlock>
        <ShareImageRow projectSlug={projectSlug} image={image} onBusy={(delta) => setUploading((count) => count + delta)} />
      </SettingsCard>
      {state.error && <FieldError>{state.error}</FieldError>}
    </form>
  );
}

/**
 * The share image as a row, as Branding's images are: its thumbnail, "Upload" (the row takes a dropped image too),
 * and once there is one a button that removes it. What went wrong with a file shows under the row.
 */
function ShareImageRow({ projectSlug, image: initial, onBusy }: { projectSlug: string; image: Image; onBusy: (delta: number) => void }) {
  const id = useId();
  const uploadButton = useRef<HTMLButtonElement>(null);
  const { image, setImage, uploading, error, dragging, drop, inputs, pick } = useImageUpload({ projectSlug, name: "seoImage", id, image: initial, onBusy });

  return (
    <div {...drop} className={cn("transition-colors", dragging && "bg-soft")}>
      <SettingRow label="Share image" description="1200×630" htmlFor={id} inline>
        {image ? (
          // eslint-disable-next-line @next/next/no-img-element -- from media storage, already resized
          <img src={image.url} alt="Share image preview" className="h-9 w-[4.25rem] rounded-lg border object-cover @max-[20rem]/settings:w-9" />
        ) : (
          <span className="flex size-9 items-center justify-center rounded-lg border border-dashed bg-muted/50 text-muted-foreground">
            <ImageIcon aria-hidden className="size-4" />
          </span>
        )}
        <Button
          type="button"
          variant="outline"
          size="sm"
          aria-label="Upload share image"
          // The size it's best at, read with the button.
          aria-describedby={`${id}-description`}
          // Off while one uploads, yet focusable (aria-disabled): focus stays here through the upload, "Uploading…" read below.
          disabled={uploading}
          focusableWhenDisabled
          ref={uploadButton}
          onClick={pick}
        >
          <UploadIcon />
          {/* The icon alone where the row has no room for the word (less of it beside the image and "Remove"). */}
          <span className={image ? "@max-[23rem]/settings:sr-only" : "@max-[18rem]/settings:sr-only"}>Upload</span>
        </Button>
        {image && (
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label="Remove share image"
            title="Remove"
            // Off while one uploads (its image would come back after), focusable all the same.
            disabled={uploading}
            focusableWhenDisabled
            onClick={() => {
              // Remove goes with the image: focus moves to Upload, not out of the row.
              uploadButton.current?.focus();
              setImage(null);
            }}
          >
            <XIcon />
          </Button>
        )}
        {inputs}
      </SettingRow>
      {uploading && (
        <p role="status" className="px-4 pb-3.5 text-sm text-muted-foreground">
          Uploading…
        </p>
      )}
      {error && <FieldError className="px-4 pb-3.5">{error}</FieldError>}
    </div>
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
            // eslint-disable-next-line @next/next/no-img-element -- from media storage, already resized
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
