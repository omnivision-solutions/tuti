"use client";

import { UPLOAD_IMAGE_TYPES } from "@tuti/content/media";
import { useActionState, useId, useState } from "react";
import { toast } from "sonner";

import { LinkRows } from "@/components/widget-settings";
import { Button } from "@/components/ui/button";
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { keepingFields } from "@/lib/forms";
import { uploadImage } from "@/lib/upload-image";
import { cn } from "@/lib/utils";
import { saveBranding } from "@/server/branding";
import type { FormState } from "@/server/form-state";

type Image = { id: string; url: string } | null;

/** How the portal and help center look: logos, favicon, colour, header and footer links, "Powered by" and the licence key that hides it (see branding.update). */
export function BrandingSettings({
  projectSlug,
  projectId,
  logo,
  logoDark,
  favicon,
  color,
  defaultColor,
  headerLinks,
  footerLinks,
  poweredBy,
  licensedUntil,
}: {
  projectSlug: string;
  projectId: string;
  logo: Image;
  logoDark: Image;
  favicon: Image;
  /** `#rrggbb`, already the default when the project hasn't picked one. */
  color: string;
  defaultColor: string;
  headerLinks: { label: string; url: string }[];
  footerLinks: { label: string; url: string }[];
  poweredBy: boolean;
  licensedUntil: Date | null;
}) {
  const [picked, setPicked] = useState(color);
  // A key typed here is checked when the form is saved, so it lets the box be unticked in the same save.
  const [typedKey, setTypedKey] = useState(false);
  const canHide = !!licensedUntil || typedKey;
  const [uploading, setUploading] = useState(0);
  const [state, action, pending] = useActionState<FormState, FormData>(async (prev, formData) => {
    const result = await saveBranding(projectSlug, prev, formData);
    if (!result.error) {
      toast.success("Branding saved");
    }
    return result;
  }, {});
  const busy = (delta: number) => setUploading((count) => count + delta);

  return (
    <form {...keepingFields(action)}>
      <FieldGroup>
        <ImageField
          projectSlug={projectSlug}
          name="logo"
          label="Logo"
          description="Shown instead of the project name in the header. PNG, JPEG, WebP or GIF (not SVG)."
          image={logo}
          look="light"
          onBusy={busy}
        />
        <ImageField
          projectSlug={projectSlug}
          name="logoDark"
          label="Logo for dark mode"
          description="Optional: a version that reads on a dark background. Without it, the logo shows in both."
          image={logoDark}
          look="dark"
          onBusy={busy}
        />
        <ImageField
          projectSlug={projectSlug}
          name="favicon"
          label="Favicon"
          description="The icon in the browser tab. A square image works best."
          image={favicon}
          look="light"
          onBusy={busy}
        />
        <Field>
          <FieldLabel htmlFor="brand-color">Accent colour</FieldLabel>
          <div className="flex items-center gap-3">
            <input
              id="brand-color"
              name="color"
              type="color"
              value={picked}
              onChange={(event) => setPicked(event.target.value)}
              className="h-9 w-14 cursor-pointer rounded-md border bg-transparent p-1"
            />
            {picked !== defaultColor && (
              <Button type="button" variant="ghost" size="sm" onClick={() => setPicked(defaultColor)}>
                Use the default green
              </Button>
            )}
          </div>
          <FieldDescription>
            For buttons and links. In light or dark mode, a colour too faint to read on the page uses the text colour
            there instead.
          </FieldDescription>
        </Field>
        <LinkRows
          name="headerLink"
          item="Header link"
          legend="Header links"
          description="Up to 5 links in the header, such as your website or docs."
          links={headerLinks}
        />
        <LinkRows
          name="footerLink"
          item="Footer link"
          legend="Footer links"
          description="Up to 5 links in the footer, such as your terms and privacy policy."
          links={footerLinks}
        />
        <Field>
          <label className="flex items-center gap-2 text-sm">
            {/* Remounted when that changes, so a disabled box is always ticked. */}
            <input
              key={String(canHide)}
              type="checkbox"
              name="poweredBy"
              defaultChecked={poweredBy}
              disabled={!canHide}
              className="size-4 accent-primary disabled:opacity-60"
            />
            Show &quot;Powered by tuti&quot; in the footer
          </label>
          {/* A disabled box isn't sent: without a licence it stays on. */}
          {!canHide && <input type="hidden" name="poweredBy" value="on" />}
          {!licensedUntil && <FieldDescription>Hiding it needs a Tuti licence for this project.</FieldDescription>}
        </Field>
        <Field>
          <FieldLabel htmlFor="license-key">Licence key</FieldLabel>
          <Input
            id="license-key"
            name="licenseKey"
            autoComplete="off"
            spellCheck={false}
            placeholder={licensedUntil ? "Paste a new key to renew" : undefined}
            onChange={(event) => setTypedKey(event.target.value.trim() !== "")}
          />
          <FieldDescription>
            {licensedUntil ? (
              <>Licensed until {licensedUntil.toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric", timeZone: "UTC" })}.</>
            ) : (
              <>
                A licence is per project, for a flat monthly fee. This project&apos;s ID:{" "}
                <code className="rounded bg-muted px-1 font-mono text-xs text-foreground">{projectId}</code>
              </>
            )}
          </FieldDescription>
        </Field>
        {state.error && <FieldError>{state.error}</FieldError>}
        <Button type="submit" disabled={pending || uploading > 0} className="self-end">
          {pending ? "Saving…" : "Save branding"}
        </Button>
      </FieldGroup>
    </form>
  );
}

/** An uploaded image: its preview on the background it's for, and its upload id in a hidden field (empty when removed). */
function ImageField({
  projectSlug,
  name,
  label,
  description,
  image: initial,
  look,
  onBusy,
}: {
  projectSlug: string;
  name: string;
  label: string;
  description: string;
  image: Image;
  look: "light" | "dark";
  onBusy: (delta: number) => void;
}) {
  const id = useId();
  const [image, setImage] = useState(initial);
  const [status, setStatus] = useState<{ uploading: true } | { error: string } | null>(null);

  const upload = async (file: File) => {
    setStatus({ uploading: true });
    onBusy(1);
    const result = await uploadImage(projectSlug, file);
    onBusy(-1);
    if ("error" in result) {
      setStatus(result);
      return;
    }
    setImage({ id: result.mediaId, url: result.src });
    setStatus(null);
  };

  return (
    <Field>
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      <input type="hidden" name={name} value={image?.id ?? ""} />
      <div className="flex flex-wrap items-center gap-3">
        {/* `light` / `dark` give the preview that mode's background (globals.css). */}
        <div className={cn(look, "flex h-14 w-32 items-center justify-center rounded-lg border bg-background p-2")}>
          {image ? (
            // eslint-disable-next-line @next/next/no-img-element -- served from the media host, already resized
            <img src={image.url} alt={`${label} preview`} className="max-h-full max-w-full object-contain" />
          ) : (
            <span className="text-xs text-muted-foreground">None</span>
          )}
        </div>
        <input
          id={id}
          type="file"
          accept={UPLOAD_IMAGE_TYPES.join(",")}
          className="max-w-full text-sm file:mr-3 file:rounded-md file:border file:bg-transparent file:px-3 file:py-1 file:text-sm file:font-medium"
          onChange={(event) => {
            const file = event.target.files?.[0];
            event.target.value = "";
            if (file) {
              void upload(file);
            }
          }}
        />
        {image && (
          <Button type="button" variant="ghost" size="sm" onClick={() => setImage(null)}>
            Remove
          </Button>
        )}
      </div>
      <FieldDescription>{description}</FieldDescription>
      {status && "uploading" in status && (
        <p role="status" className="text-sm text-muted-foreground">
          Uploading…
        </p>
      )}
      {status && "error" in status && <FieldError>{status.error}</FieldError>}
    </Field>
  );
}
