"use client";

import { UPLOAD_IMAGE_TYPES } from "@tuti/content/media";
import { MonitorIcon, MoonIcon, SunIcon, UploadIcon } from "lucide-react";
import Link from "next/link";
import { useId, useRef, useState } from "react";
import { toast } from "sonner";

import { CustomizeSection, type Draft, useCustomizeForm, useFieldChanged, usePreview } from "@/components/customize-shell";
import { LinkRows } from "@/components/widget-settings";
import { Button, buttonVariants } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { linksFrom } from "@/lib/forms";
import { LICENSE_UNREACHABLE, licenseCheckOutcome } from "@/lib/license-check";
import { BADGE_PRICE } from "@/lib/plans";
import { isPortalFont, PORTAL_FONTS, type PortalFont } from "@/lib/portal-fonts";
import { COLOR_SCHEMES, type ColorScheme, CONTACT_LABEL_MAX, LOGO_TEXT_MAX } from "@/lib/portal-look";
import { uploadImage } from "@/lib/upload-image";
import { cn } from "@/lib/utils";
import { checkBrandingLicense, saveBranding } from "@/server/branding";

type Image = { id: string; url: string } | null;

/**
 * One part of the branding's form (see branding.update and saveBranding), saved with the panel's
 * "Save changes" (with a toast, and then the preview shows what's saved), and shown in the preview as
 * it's changed (`toDraft`).
 */
export function useBrandingForm(projectSlug: string, message: string, toDraft: (data: FormData) => Draft, busy = false) {
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
const fontOf = (data: FormData, name: string): PortalFont | null => {
  const value = text(data, name);
  return isPortalFont(value) ? value : null;
};
const image = (data: FormData, name: string) => (text(data, `${name}Url`) ? { url: text(data, `${name}Url`) } : null);
/** Links as the portal would show them: rows with both a label and an address. */
const shownLinks = (data: FormData, prefix: string) => linksFrom(data, prefix).filter((link) => link.label.trim() && link.url.trim());

const SCHEMES = [
  ["system", "System", MonitorIcon],
  ["light", "Light", SunIcon],
  ["dark", "Dark", MoonIcon],
] as const;

/**
 * Customize → Branding (see branding.update): the default colour scheme and the accent colour; the
 * logos, the text beside them and where they link; the favicon.
 */
export function BrandingSettings({
  projectSlug,
  logo,
  logoDark,
  favicon,
  color,
  defaultColor,
  colorScheme,
  logoText,
  logoLink,
  fonts,
}: {
  projectSlug: string;
  logo: Image;
  logoDark: Image;
  favicon: Image;
  /** `#rrggbb`, already the default when the project hasn't picked one. */
  color: string;
  defaultColor: string;
  colorScheme: ColorScheme;
  logoText: string;
  logoLink: string | null;
  fonts: { heading: PortalFont | null; body: PortalFont | null };
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
      colorScheme: (COLOR_SCHEMES as readonly string[]).includes(text(data, "colorScheme")) ? (text(data, "colorScheme") as ColorScheme) : "system",
      logoText: text(data, "logoText").trim(),
      // A link only once it's a whole address, as saving needs.
      logoLink: /^https:\/\/[^/\s]+\.[^/\s]+/.test(text(data, "logoLink").trim()) ? text(data, "logoLink").trim() : null,
      fonts: { heading: fontOf(data, "headingFont"), body: fontOf(data, "bodyFont") },
    }),
    uploading > 0,
  );
  const busy = (delta: number) => setUploading((count) => count + delta);

  return (
    <form {...form} className="flex flex-col gap-6">
      <input type="hidden" name="part" value="look" />
      <CustomizeSection title="Colour scheme" description="For readers who haven't picked light or dark mode themselves.">
        <div role="radiogroup" aria-label="Colour scheme" className="flex w-fit gap-1 rounded-lg bg-muted p-1">
          {SCHEMES.map(([value, name, Icon]) => (
            <label
              key={value}
              className="flex cursor-pointer items-center gap-1.5 rounded-md px-3 py-1 text-sm text-muted-foreground has-checked:bg-background has-checked:text-foreground has-checked:shadow-sm"
            >
              <input type="radio" name="colorScheme" value={value} defaultChecked={colorScheme === value} className="sr-only" />
              <Icon aria-hidden className="size-3.5" />
              {name}
            </label>
          ))}
        </div>
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
      </CustomizeSection>
      <CustomizeSection title="Logo" description="What's at the top left of your portal and docs.">
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
          <Field>
            <FieldLabel htmlFor="logo-text">Logo text</FieldLabel>
            <Input id="logo-text" name="logoText" defaultValue={logoText} maxLength={LOGO_TEXT_MAX} autoComplete="off" />
            <FieldDescription>Beside your logo. Leave it empty to show the logo alone (or, without a logo, your project&apos;s name).</FieldDescription>
          </Field>
          <Field>
            <FieldLabel htmlFor="logo-link">Logo link</FieldLabel>
            <Input id="logo-link" name="logoLink" type="url" defaultValue={logoLink ?? ""} placeholder="Leave empty for your portal's home" autoComplete="off" />
            <FieldDescription>Where the logo goes when it&apos;s clicked, such as your website.</FieldDescription>
          </Field>
        </FieldGroup>
      </CustomizeSection>
      <CustomizeSection title="Typography" description="Fonts for your portal's headings and text. They're served from Tuti, not Google.">
        <FieldGroup>
          <FontSelect id="heading-font" name="headingFont" label="Heading font" font={fonts.heading} />
          <FontSelect id="body-font" name="bodyFont" label="Body font" font={fonts.body} />
        </FieldGroup>
      </CustomizeSection>
      <CustomizeSection title="Favicon" description="The icon in the browser tab.">
        <ImageField projectSlug={projectSlug} name="favicon" label="Favicon" description="A square image works best." image={favicon} look="light" onBusy={busy} />
      </CustomizeSection>
      {state.error && <FieldError>{state.error}</FieldError>}
    </form>
  );
}

/** A font for the portal, or the page's own: a native select, so the form sends it and its changes bubble. */
function FontSelect({ id, name, label, font }: { id: string; name: string; label: string; font: PortalFont | null }) {
  return (
    <Field>
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      <select
        id={id}
        name={name}
        defaultValue={font ?? ""}
        className="h-8 w-full rounded-lg border border-input bg-transparent px-2.5 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
      >
        <option value="">Page default</option>
        {PORTAL_FONTS.map((option) => (
          <option key={option.id} value={option.id}>
            {option.name}
          </option>
        ))}
      </select>
    </Field>
  );
}

/** Customize → Navigation (see branding.update): links in the header, the footer and above the docs' tree, and a "Contact us" button. */
export function NavigationSettings({
  projectSlug,
  headerLinks,
  footerLinks,
  sidebarLinks,
  contact,
}: {
  projectSlug: string;
  headerLinks: { label: string; url: string }[];
  footerLinks: { label: string; url: string }[];
  sidebarLinks: { label: string; url: string }[];
  contact: { label: string; url: string } | null;
}) {
  const { state, form } = useBrandingForm(projectSlug, "Navigation saved", (data) => {
    const url = text(data, "contactUrl").trim();
    return {
      headerLinks: shownLinks(data, "headerLink"),
      footerLinks: shownLinks(data, "footerLink"),
      sidebarLinks: shownLinks(data, "sidebarLink"),
      contact: /^(https:\/\/[^/\s]+\.[^/\s]+|mailto:\S+@\S+)/i.test(url) ? { label: text(data, "contactLabel").trim(), url } : null,
    };
  });
  return (
    <form {...form} className="flex flex-col gap-6">
      <input type="hidden" name="part" value="links" />
      <CustomizeSection title="Header links" description="Up to 5, such as your website or pricing.">
        <LinkRows name="headerLink" item="Header link" legend="Header links" links={headerLinks} />
      </CustomizeSection>
      <CustomizeSection title="Contact us" description="A button at the right of the header, to a page or an email address.">
        <FieldGroup>
          <Field>
            <FieldLabel htmlFor="contact-url">Goes to</FieldLabel>
            <Input id="contact-url" name="contactUrl" defaultValue={contact?.url ?? ""} placeholder="https://example.com/contact or mailto:help@example.com" autoComplete="off" />
            <FieldDescription>Leave it empty for no button.</FieldDescription>
          </Field>
          <Field>
            <FieldLabel htmlFor="contact-label">Label</FieldLabel>
            <Input id="contact-label" name="contactLabel" defaultValue={contact?.label ?? ""} maxLength={CONTACT_LABEL_MAX} placeholder="Contact us" autoComplete="off" />
          </Field>
        </FieldGroup>
      </CustomizeSection>
      <CustomizeSection title="Docs sidebar links" description="Up to 5 above your docs' tree, such as your status page or changelog.">
        <LinkRows name="sidebarLink" item="Sidebar link" legend="Docs sidebar links" links={sidebarLinks} />
      </CustomizeSection>
      <CustomizeSection title="Footer links" description="Up to 5, such as your terms and privacy policy.">
        <LinkRows name="footerLink" item="Footer link" legend="Footer links" links={footerLinks} />
      </CustomizeSection>
      {state.error && <FieldError>{state.error}</FieldError>}
    </form>
  );
}

/** What hiding the badge takes where plans are sold (tuti.so): the add-on on the project's plan, bought on Billing. */
type BadgePlan = { addOn: boolean; billingUrl: string };

/** Customize → Powered by: "Powered by tuti" in the footer, which needs a licence (or on tuti.so the add-on) to hide (see branding.update). */
export function PoweredBySettings({
  projectSlug,
  poweredBy,
  licensedUntil,
  buyLicenseUrl,
  plan,
}: {
  projectSlug: string;
  poweredBy: boolean;
  /** When the project's licence expires; null without one. */
  licensedUntil: Date | null;
  /** tuti.so/license for this installation and project. */
  buyLicenseUrl: string;
  /** Where plans are sold; null elsewhere. */
  plan: BadgePlan | null;
}) {
  const { state, form } = useBrandingForm(projectSlug, "Saved", (data) => ({ poweredBy: data.get("poweredBy") === "on" }));
  return (
    <form {...form}>
      <input type="hidden" name="part" value="poweredBy" />
      <FieldGroup>
        <PoweredByField projectSlug={projectSlug} poweredBy={poweredBy} licensedUntil={licensedUntil} buyLicenseUrl={buyLicenseUrl} plan={plan} />
        {state.error && <FieldError>{state.error}</FieldError>}
      </FieldGroup>
    </form>
  );
}

/** An uploaded image: its preview on the background it's for, and its upload id in a hidden field (empty when removed). */
export function ImageField({
  projectSlug,
  name,
  label,
  description,
  image: initial,
  look,
  onBusy,
  onRemove,
}: {
  projectSlug: string;
  name: string;
  label: string;
  description: string;
  image: Image;
  /** The background it's for; the page's own without one. */
  look?: "light" | "dark";
  onBusy: (delta: number) => void;
  /** After "Remove", for a form whose other fields depend on there being an image. */
  onRemove?: () => void;
}) {
  const id = useId();
  const [image, setImage] = useState(initial);
  const [status, setStatus] = useState<{ uploading: true } | { error: string } | null>(null);
  const field = useRef<HTMLInputElement>(null);
  const picker = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  useFieldChanged(field, image);

  // One at a time: Upload and dropping wait while one is on its way, so every upload's onBusy(1) has its onBusy(-1)
  // and none is left behind by a newer one (a form waiting on onBusy, like the changelog's Save, would wait for good).
  const uploading = status !== null && "uploading" in status;
  const upload = async (file: File) => {
    if (uploading) {
      return;
    }
    setStatus({ uploading: true });
    onBusy(1);
    // A server action that fails (the network drops, a deploy lands) rejects: the upload still ends, with an error.
    const result = await uploadImage(projectSlug, file)
      .catch(() => ({ error: "The upload failed. Try again." }))
      .finally(() => onBusy(-1));
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
      {/* Dropped here, or picked with "Upload" (the file input itself stays out of sight and out of the tab order). */}
      <div
        // Not in a disabled fieldset (a setting the plan doesn't include): the file input and buttons are off there too.
        onDragOver={(event) => {
          event.preventDefault();
          setDragging(!uploading && !event.currentTarget.closest("fieldset:disabled"));
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(event) => {
          event.preventDefault();
          setDragging(false);
          if (event.currentTarget.closest("fieldset:disabled")) {
            return;
          }
          const file = event.dataTransfer.files[0];
          if (file) {
            void upload(file);
          }
        }}
        className={cn(
          "flex flex-wrap items-center gap-3 rounded-lg border border-dashed p-3 transition-colors",
          dragging && "border-primary bg-soft",
        )}
      >
        {/* `light` / `dark` give the preview that mode's background (globals.css). */}
        <div className={cn(look, "flex h-14 w-32 items-center justify-center rounded-lg border bg-background p-2")}>
          {image ? (
            // eslint-disable-next-line @next/next/no-img-element -- from media storage, already resized
            <img src={image.url} alt={`${label} preview`} className="max-h-full max-w-full object-contain" />
          ) : (
            <span className="text-xs text-muted-foreground">None</span>
          )}
        </div>
        <div className="flex flex-col gap-1">
          <div className="flex gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              aria-label={`Upload ${label.charAt(0).toLowerCase()}${label.slice(1)}`}
              // Off while one uploads, yet focusable (aria-disabled): focus stays here through the upload, "Uploading…" read below.
              disabled={uploading}
              focusableWhenDisabled
              onClick={() => picker.current?.click()}
            >
              <UploadIcon />
              Upload
            </Button>
            {image && (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => {
                  setImage(null);
                  onRemove?.();
                }}
              >
                Remove
              </Button>
            )}
          </div>
          <span className="text-xs text-muted-foreground">or drop an image here</span>
        </div>
        <input
          ref={picker}
          id={id}
          type="file"
          tabIndex={-1}
          disabled={uploading}
          accept={UPLOAD_IMAGE_TYPES.join(",")}
          className="sr-only"
          onChange={(event) => {
            const file = event.target.files?.[0];
            event.target.value = "";
            if (file) {
              void upload(file);
            }
          }}
        />
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

const untilDate = (date: Date) => date.toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric", timeZone: "UTC" });

/**
 * "Powered by tuti" in the footer: on, unless the project has a licence (or the add-on on its plan).
 * Without one, unticking it opens a dialog instead: why the badge matters, and where to buy a licence
 * (and Check now), or where plans are sold, the add-on on Billing.
 */
function PoweredByField({
  projectSlug,
  poweredBy,
  licensedUntil: initial,
  buyLicenseUrl,
  plan,
}: {
  projectSlug: string;
  poweredBy: boolean;
  licensedUntil: Date | null;
  buyLicenseUrl: string;
  plan: BadgePlan | null;
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
      setMessage(LICENSE_UNREACHABLE);
      return;
    } finally {
      setChecking(false);
    }
    const outcome = licenseCheckOutcome(result);
    if ("message" in outcome) {
      setMessage(outcome.message);
      return;
    }
    setLicensedUntil(outcome.licensedUntil);
    setShown(false);
    setOpen(false);
    toast.success(`Licensed until ${untilDate(outcome.licensedUntil)}. Save your changes to hide the badge.`);
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
            if (!event.target.checked && !licensedUntil && !plan?.addOn) {
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
        {plan?.addOn
          ? "Hidden with the add-on on this project's plan."
          : licensedUntil
            ? `Licensed until ${untilDate(licensedUntil)}.`
            : plan
              ? "Hiding it is an add-on to a paid plan."
              : "Hiding it needs a licence for this project."}
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
          {plan ? (
            <p className="text-sm">To remove it from this project, add it to its plan in Billing: ${BADGE_PRICE} a month, on Pro or Business.</p>
          ) : (
            <p className="text-sm">To remove it from this project, get a licence: a flat monthly fee per project.</p>
          )}
          {message && (
            <p role="status" className="text-sm text-muted-foreground">
              {message}
            </p>
          )}
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => setOpen(false)}>
              Keep the badge
            </Button>
            {plan ? (
              <Link href={plan.billingUrl} className={buttonVariants()}>
                See Billing
              </Link>
            ) : (
              <>
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
              </>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Field>
  );
}
