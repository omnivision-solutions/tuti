"use client";

import { UPLOAD_IMAGE_TYPES } from "@tuti/content/media";
import { useId, useRef, useState } from "react";
import { toast } from "sonner";

import { type Draft, useCustomizeForm, useFieldChanged, usePreview } from "@/components/customize-shell";
import { LinkRows } from "@/components/widget-settings";
import { Button, buttonVariants } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field";
import { linksFrom } from "@/lib/forms";
import { uploadImage } from "@/lib/upload-image";
import { cn } from "@/lib/utils";
import { checkBrandingLicense, saveBranding } from "@/server/branding";

type Image = { id: string; url: string } | null;

/**
 * One part of the branding's form (see branding.update and saveBranding), saved with the panel's
 * "Save changes" (with a toast, and then the preview shows what's saved), and shown in the preview as
 * it's changed (`toDraft`).
 */
function useBrandingForm(projectSlug: string, message: string, toDraft: (data: FormData) => Draft, busy = false) {
  const preview = usePreview();
  return useCustomizeForm({
    save: (prev, formData) => saveBranding(projectSlug, prev, formData),
    onSaved: () => {
      toast.success(message);
      preview.reload();
    },
    toDraft,
    busy,
  });
}

const text = (data: FormData, name: string) => {
  const value = data.get(name);
  return typeof value === "string" ? value : "";
};
const image = (data: FormData, name: string) => (text(data, `${name}Url`) ? { url: text(data, `${name}Url`) } : null);
/** Links as the portal would show them: rows with both a label and an address. */
const shownLinks = (data: FormData, prefix: string) => linksFrom(data, prefix).filter((link) => link.label.trim() && link.url.trim());

/** Customize → Branding: the portal's and its docs' logos, favicon and colour (see branding.update). */
export function BrandingSettings({
  projectSlug,
  logo,
  logoDark,
  favicon,
  color,
  defaultColor,
}: {
  projectSlug: string;
  logo: Image;
  logoDark: Image;
  favicon: Image;
  /** `#rrggbb`, already the default when the project hasn't picked one. */
  color: string;
  defaultColor: string;
}) {
  const [picked, setPicked] = useState(color);
  const colorField = useRef<HTMLInputElement>(null);
  useFieldChanged(colorField, picked);
  const [uploading, setUploading] = useState(0);
  const { state, form } = useBrandingForm(
    projectSlug,
    "Branding saved",
    (data) => ({
      color: text(data, "color") === defaultColor ? null : text(data, "color") || null,
      logo: image(data, "logo"),
      logoDark: image(data, "logoDark"),
    }),
    uploading > 0,
  );
  const busy = (delta: number) => setUploading((count) => count + delta);

  return (
    <form {...form}>
      <input type="hidden" name="part" value="look" />
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
              ref={colorField}
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
        {state.error && <FieldError>{state.error}</FieldError>}
      </FieldGroup>
    </form>
  );
}

/** Customize → Navigation: links in the portal's header and footer (see branding.update). */
export function NavigationSettings({
  projectSlug,
  headerLinks,
  footerLinks,
}: {
  projectSlug: string;
  headerLinks: { label: string; url: string }[];
  footerLinks: { label: string; url: string }[];
}) {
  const { state, form } = useBrandingForm(projectSlug, "Navigation saved", (data) => ({
    headerLinks: shownLinks(data, "headerLink"),
    footerLinks: shownLinks(data, "footerLink"),
  }));
  return (
    <form {...form}>
      <input type="hidden" name="part" value="links" />
      <FieldGroup>
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
        {state.error && <FieldError>{state.error}</FieldError>}
      </FieldGroup>
    </form>
  );
}

/** Customize → Powered by: "Powered by tuti" in the footer, which needs a licence to hide (see branding.update). */
export function PoweredBySettings({
  projectSlug,
  poweredBy,
  licensedUntil,
  buyLicenseUrl,
}: {
  projectSlug: string;
  poweredBy: boolean;
  /** When the project's licence expires; null without one. */
  licensedUntil: Date | null;
  /** tuti.so/license for this installation and project. */
  buyLicenseUrl: string;
}) {
  const { state, form } = useBrandingForm(projectSlug, "Saved", (data) => ({ poweredBy: data.get("poweredBy") === "on" }));
  return (
    <form {...form}>
      <input type="hidden" name="part" value="poweredBy" />
      <FieldGroup>
        <PoweredByField projectSlug={projectSlug} poweredBy={poweredBy} licensedUntil={licensedUntil} buyLicenseUrl={buyLicenseUrl} />
        {state.error && <FieldError>{state.error}</FieldError>}
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
  const field = useRef<HTMLInputElement>(null);
  useFieldChanged(field, image);

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
      <input ref={field} type="hidden" name={name} value={image?.id ?? ""} />
      {/* For the preview only (saveBranding reads the id). */}
      <input type="hidden" name={`${name}Url`} value={image?.url ?? ""} />
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

const CHECKED: Record<"not_licensed" | "in_use" | "unreachable" | "busy", string> = {
  not_licensed: "No licence for this project yet. Once you've bought one, check again.",
  in_use: "This project's licence is in use on another installation of Tuti. Email hello@tuti.so to move it here.",
  unreachable: "Couldn't reach tuti.so. Try again in a few minutes.",
  busy: "Checked a moment ago. Try again in a minute.",
};

const untilDate = (date: Date) => date.toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric", timeZone: "UTC" });

/**
 * "Powered by tuti" in the footer: on, unless the project has a licence. Without one, unticking it
 * opens a dialog instead: why the badge matters, where to buy a licence, and Check now.
 */
function PoweredByField({
  projectSlug,
  poweredBy,
  licensedUntil: initial,
  buyLicenseUrl,
}: {
  projectSlug: string;
  poweredBy: boolean;
  licensedUntil: Date | null;
  buyLicenseUrl: string;
}) {
  const [shown, setShown] = useState(poweredBy);
  const box = useRef<HTMLInputElement>(null);
  useFieldChanged(box, shown);
  const [licensedUntil, setLicensedUntil] = useState(initial);
  const [open, setOpen] = useState(false);
  const [checking, setChecking] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const check = async () => {
    setChecking(true);
    setMessage(null);
    let result: Awaited<ReturnType<typeof checkBrandingLicense>>;
    try {
      result = await checkBrandingLicense(projectSlug);
    } catch {
      setMessage(CHECKED.unreachable);
      return;
    } finally {
      setChecking(false);
    }
    if (result.licensedUntil) {
      setLicensedUntil(result.licensedUntil);
      setShown(false);
      setOpen(false);
      toast.success(`Licensed until ${untilDate(result.licensedUntil)}. Save your changes to hide the badge.`);
      return;
    }
    setMessage(result.error ?? CHECKED[result.status === "licensed" || !result.status ? "unreachable" : result.status]);
  };

  return (
    <Field>
      <label className="flex items-center gap-2 text-sm">
        <input
          ref={box}
          type="checkbox"
          name="poweredBy"
          checked={shown}
          onChange={(event) => {
            if (!event.target.checked && !licensedUntil) {
              setMessage(null);
              setOpen(true);
              return;
            }
            setShown(event.target.checked);
          }}
          className="size-4 accent-primary"
        />
        Show &quot;Powered by tuti&quot; in the footer
      </label>
      <FieldDescription>
        {licensedUntil ? `Licensed until ${untilDate(licensedUntil)}.` : "Hiding it needs a licence for this project."}
      </FieldDescription>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Keep &quot;Powered by tuti&quot;?</DialogTitle>
            <DialogDescription>
              The badge is how people find Tuti. Keeping it helps us spread the word, and brings in contributors who keep
              the project maintained.
            </DialogDescription>
          </DialogHeader>
          <p className="text-sm">To remove it from this project, get a licence: a flat monthly fee per project.</p>
          {message && (
            <p role="status" className="text-sm text-muted-foreground">
              {message}
            </p>
          )}
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => setOpen(false)}>
              Keep the badge
            </Button>
            <Button type="button" variant="outline" disabled={checking} onClick={() => void check()}>
              {checking ? "Checking…" : "Check now"}
            </Button>
            <a
              href={buyLicenseUrl}
              target="_blank"
              rel="noreferrer"
              className={buttonVariants()}
              // From now on, this installation checks daily whether the licence has been bought. The dialog
              // says what this first check found (or that it failed) when they come back from tuti.so.
              onClick={() => void check()}
            >
              Get a licence
            </a>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Field>
  );
}
