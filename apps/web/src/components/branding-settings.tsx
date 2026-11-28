"use client";

import { UPLOAD_IMAGE_TYPES } from "@tuti/content/media";
import { ImageIcon, MonitorIcon, MoonIcon, PlusIcon, SunIcon, UploadIcon, XIcon } from "lucide-react";
import Link from "next/link";
import { type ReactNode, useEffect, useId, useRef, useState } from "react";
import { toast } from "sonner";

import { ColorField } from "@/components/color-field";
import { type Draft, useCustomizeForm, useFieldChanged, usePreview } from "@/components/customize-shell";
import { SettingRow, SettingsCard } from "@/components/settings-card";
import { Button, buttonVariants } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Field, FieldDescription, FieldError, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Segmented } from "@/components/ui/segmented";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { formatDate } from "@/lib/format";
import { linksFrom } from "@/lib/forms";
import { LICENSE_UNREACHABLE, licenseCheckOutcome } from "@/lib/license-check";
import { isPortalFont, PORTAL_FONTS, type PortalFont } from "@/lib/portal-fonts";
import { COLOR_SCHEMES, type ColorScheme, LOGO_TEXT_MAX } from "@/lib/portal-look";
import { uploadImage } from "@/lib/upload-image";
import { cn } from "@/lib/utils";
import { errorMessage, useTRPCClient } from "@/components/trpc";
import { checkBrandingLicense, saveBranding } from "@/server/branding";
import type { updateBranding } from "@/server/operations/branding";
import type { InputOf } from "@/server/operations/define";

type Image = { id: string; url: string } | null;

/**
 * One part of the branding's form (see branding.update), saved with the panel's "Save changes" (with a toast, and then
 * the preview shows what's saved), and shown in the preview as it's changed (`toDraft`). With `input`, it saves through
 * tRPC; without, through saveBranding until each screen moves (docs/plan.md, "One way in", T3).
 */
export function useBrandingForm(
  projectSlug: string,
  message: string,
  toDraft: (data: FormData) => Draft,
  busy = false,
  input?: (data: FormData) => Omit<InputOf<typeof updateBranding>, "project">,
) {
  const preview = usePreview();
  const trpc = useTRPCClient();
  return useCustomizeForm({
    save: async (prev, formData) => {
      if (!input) {
        return saveBranding(projectSlug, prev, formData);
      }
      try {
        await trpc.branding.update.mutate({ project: projectSlug, ...input(formData) });
      } catch (error) {
        return { error: errorMessage(error) };
      }
      return {};
    },
    onSaved: () => {
      toast.success(message);
      // Refreshes the page too (usePreviewPage's reload), so what it shows is what's saved: one refresh a save.
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

/** The default theme's options: an icon each (the column is narrow), named for screen readers. */
const SCHEMES = [
  { value: "system", label: <span className="sr-only">System</span>, icon: <MonitorIcon aria-hidden /> },
  { value: "light", label: <span className="sr-only">Light</span>, icon: <SunIcon aria-hidden /> },
  { value: "dark", label: <span className="sr-only">Dark</span>, icon: <MoonIcon aria-hidden /> },
] as const;

/** A text field and a select on a row's right: narrower in the settings column at its narrowest, so their labels keep one line. */
const ROW_INPUT = "w-28 @min-[20rem]/settings:w-40";
const ROW_SELECT = "w-32 @min-[20rem]/settings:w-40";

/**
 * Settings → Branding (see branding.update): the default colour scheme and the accent colour; the
 * logos, the text beside them and where they link; the fonts; the favicon, and after it in the last
 * card `children` ("Powered by tuti", saved with the rest). A setting is a row (docs/design.md →
 * Settings rows) that fits the settings column at its narrowest, 17rem of card.
 */
export function BrandingSettings({
  projectSlug,
  logo,
  logoDark,
  favicon,
  color,
  defaultColor,
  colorScheme,
  themeSwitch,
  logoText,
  logoLink,
  fonts,
  children,
}: {
  projectSlug: string;
  logo: Image;
  logoDark: Image;
  favicon: Image;
  /** `#rrggbb`, already the default when the project hasn't picked one. */
  color: string;
  defaultColor: string;
  colorScheme: ColorScheme;
  themeSwitch: boolean;
  logoText: string;
  logoLink: string | null;
  fonts: { heading: PortalFont | null; body: PortalFont | null };
  children?: ReactNode;
}) {
  const [uploading, setUploading] = useState(0);
  const preview = usePreview();
  const { state, form } = useCustomizeForm({
    save: async (prev, data) => {
      const result = await saveBranding(projectSlug, prev, data);
      if (!result.error && data.has("poweredBy")) {
        // The badge's change is saved, so the form holds none (see PoweredBySettings): what it sent, for "Save changes".
        data.set("poweredBy", "");
      }
      return result;
    },
    onSaved: () => {
      toast.success("Branding saved");
      preview.reload();
    },
    toDraft: (data) => ({
      color: text(data, "color") === defaultColor ? null : text(data, "color") || null,
      logo: image(data, "logo"),
      logoDark: image(data, "logoDark"),
      colorScheme: (COLOR_SCHEMES as readonly string[]).includes(text(data, "colorScheme")) ? (text(data, "colorScheme") as ColorScheme) : "system",
      themeSwitch: data.getAll("themeSwitch").includes("on"),
      logoText: text(data, "logoText").trim(),
      // A link only once it's a whole address, as saving needs.
      logoLink: /^https:\/\/[^/\s]+\.[^/\s]+/.test(text(data, "logoLink").trim()) ? text(data, "logoLink").trim() : null,
      fonts: { heading: fontOf(data, "headingFont"), body: fontOf(data, "bodyFont") },
    }),
    busy: uploading > 0,
  });
  const busy = (delta: number) => setUploading((count) => count + delta);
  const id = useId();

  return (
    <form {...form} className="flex flex-col gap-4">
      <input type="hidden" name="part" value="look" />
      <SettingsCard title="Theme">
        <SettingRow label={<span id={`${id}-theme`}>Default theme</span>} inline>
          <Segmented name="colorScheme" aria-labelledby={`${id}-theme`} defaultValue={colorScheme} options={SCHEMES} className="@max-[20rem]/settings:*:px-2" />
        </SettingRow>
        <SettingRow label="Readers can switch" htmlFor={`${id}-switch`} inline>
          {/* Sent off or on (see saveBranding). */}
          <input type="hidden" name="themeSwitch" value="" />
          <Switch id={`${id}-switch`} name="themeSwitch" defaultChecked={themeSwitch} />
        </SettingRow>
        {/* Under its label: "Use the default green" and a wrong hex's error need the column's width. */}
        <SettingRow
          label="Accent colour"
          htmlFor="brand-color"
          info="For buttons and links. In light or dark mode, a colour too faint to read on the page uses a darker or lighter shade of it there (the text colour, for a grey or a very pale tint)."
        >
          <ColorField id="brand-color" name="color" label="Accent colour" color={color} defaultColor={defaultColor} />
        </SettingRow>
      </SettingsCard>
      <SettingsCard title="Header">
        <ImageRow projectSlug={projectSlug} name="logo" label="Logo" image={logo} look="light" onBusy={busy} />
        <ImageRow projectSlug={projectSlug} name="logoDark" label="Dark mode logo" image={logoDark} look="dark" onBusy={busy} />
        <SettingRow label="Text beside it" htmlFor="logo-text" inline>
          <Input id="logo-text" name="logoText" defaultValue={logoText} maxLength={LOGO_TEXT_MAX} autoComplete="off" className={ROW_INPUT} />
        </SettingRow>
        <SettingRow label="Links to" htmlFor="logo-link" inline>
          <Input id="logo-link" name="logoLink" type="url" defaultValue={logoLink ?? ""} placeholder="Portal home" autoComplete="off" className={ROW_INPUT} />
        </SettingRow>
      </SettingsCard>
      <SettingsCard title="Fonts">
        <FontSelect id="heading-font" name="headingFont" label="Headings" font={fonts.heading} />
        <FontSelect id="body-font" name="bodyFont" label="Text" font={fonts.body} />
      </SettingsCard>
      <SettingsCard title="More">
        <ImageRow projectSlug={projectSlug} name="favicon" label="Favicon" image={favicon} look="light" onBusy={busy} />
        {children}
      </SettingsCard>
      {state.error && <FieldError>{state.error}</FieldError>}
    </form>
  );
}

const FONT_ITEMS = [{ value: null, label: "Inter" }, ...PORTAL_FONTS.map((font) => ({ value: font.id, label: font.name }))];

/** A font for the portal, or the page's own (sent empty). */
function FontSelect({ id, name, label, font }: { id: string; name: string; label: string; font: PortalFont | null }) {
  const [value, setValue] = useState(font);
  // The select's own field in the form: it says when it changed, for the preview and "Save changes".
  const field = useRef<HTMLInputElement>(null);
  useFieldChanged(field, value);
  return (
    <SettingRow label={<span id={`${id}-label`}>{label}</span>} inline>
      <Select name={name} items={FONT_ITEMS} value={value} onValueChange={(next) => setValue(next as PortalFont | null)} inputRef={field}>
        <SelectTrigger className={ROW_SELECT} aria-labelledby={`${id}-label`}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {FONT_ITEMS.map((item) => (
            <SelectItem key={item.value ?? ""} value={item.value}>
              {item.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </SettingRow>
  );
}

/**
 * An uploaded image as a row: its thumbnail on the background it's for, "Upload" (the row takes a dropped image
 * too), and once there is one a button that removes it. What went wrong with a file shows under the row.
 */
function ImageRow({
  projectSlug,
  name,
  label,
  image: initial,
  look,
  onBusy,
}: {
  projectSlug: string;
  name: string;
  label: string;
  image: Image;
  look: "light" | "dark";
  onBusy: (delta: number) => void;
}) {
  const id = useId();
  const uploadButton = useRef<HTMLButtonElement>(null);
  const { image, setImage, uploading, error, dragging, drop, inputs, pick } = useImageUpload({ projectSlug, name, id, image: initial, onBusy });
  const what = `${label.charAt(0).toLowerCase()}${label.slice(1)}`;

  return (
    <div {...drop} className={cn("transition-colors", dragging && "bg-soft")}>
      <SettingRow label={label} htmlFor={id} inline>
        {image ? (
          // `light` / `dark` give the thumbnail that mode's background (globals.css).
          <span className={cn(look, "flex h-9 w-9 items-center justify-center rounded-lg border bg-background p-1 @min-[23rem]/settings:w-14")}>
            {/* eslint-disable-next-line @next/next/no-img-element -- from media storage, already resized */}
            <img src={image.url} alt={`${label} preview`} className="max-h-full max-w-full object-contain" />
          </span>
        ) : (
          <span className="flex size-9 items-center justify-center rounded-lg border border-dashed bg-muted/50 text-muted-foreground">
            <ImageIcon aria-hidden className="size-4" />
          </span>
        )}
        <Button
          type="button"
          variant="outline"
          size="sm"
          aria-label={`Upload ${what}`}
          // Off while one uploads, yet focusable (aria-disabled): focus stays here through the upload, "Uploading…" read below.
          disabled={uploading}
          focusableWhenDisabled
          ref={uploadButton}
          onClick={pick}
        >
          <UploadIcon />
          {/* The icon alone where the row has no room for the word (less of it beside "Remove"). */}
          <span className={image ? "@max-[22rem]/settings:sr-only" : "@max-[20rem]/settings:sr-only"}>Upload</span>
        </Button>
        {image && (
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label={`Remove ${what}`}
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

/** As many links as the header, the footer or the docs' sidebar takes (see branding.update). */
const MAX_LINKS = 5;

/**
 * Settings → Portal → Navigation (see branding.update): the links in the header, above the docs' tree and in the
 * footer, a row each in one card, saved with the pane's "Save changes".
 */
export function NavigationSettings({
  projectSlug,
  headerLinks,
  footerLinks,
  sidebarLinks,
}: {
  projectSlug: string;
  headerLinks: { label: string; url: string }[];
  footerLinks: { label: string; url: string }[];
  sidebarLinks: { label: string; url: string }[];
}) {
  const { state, form } = useBrandingForm(projectSlug, "Navigation saved", (data) => ({
    headerLinks: shownLinks(data, "headerLink"),
    footerLinks: shownLinks(data, "footerLink"),
    sidebarLinks: shownLinks(data, "sidebarLink"),
  }));
  return (
    <form {...form} className="flex flex-col gap-4">
      <input type="hidden" name="part" value="links" />
      <SettingsCard title="Links">
        <LinksRow name="headerLink" label="Header" item="Header link" legend="Header links" links={headerLinks} />
        <LinksRow name="sidebarLink" label="Docs sidebar" item="Sidebar link" legend="Docs sidebar links" links={sidebarLinks} />
        <LinksRow name="footerLink" label="Footer" item="Footer link" legend="Footer links" links={footerLinks} />
      </SettingsCard>
      {state.error && <FieldError>{state.error}</FieldError>}
    </form>
  );
}

/**
 * One place's links as a row: how many of the 5 it has beside its label, "Add" on the right (at 5 it says so instead), and under them
 * a line per link, its label and https URL sent as `<name>Label` and `<name>Url` (read with `linksFrom`). `item` names
 * a link for screen readers ("Header link 1 label").
 */
function LinksRow({ name, label, item, legend, links }: { name: string; label: string; item: string; legend: string; links: { label: string; url: string }[] }) {
  const [rows, setRows] = useState(() => links.map((link, i) => ({ ...link, key: i })));
  // The link "Add" just made: its label takes the focus.
  const [added, setAdded] = useState<number | null>(null);
  const fieldset = useRef<HTMLFieldSetElement>(null);
  const addButton = useRef<HTMLButtonElement>(null);
  useFieldChanged(fieldset, rows);
  return (
    <fieldset ref={fieldset} aria-label={legend} className="min-w-0">
      <SettingRow
        label={
          <>
            {label} <span className="font-normal text-muted-foreground">{rows.length}/{MAX_LINKS}</span>
          </>
        }
        inline
      >
        <Button
          type="button"
          variant="outline"
          size="sm"
          aria-label={`Add ${item.toLowerCase()}`}
          ref={addButton}
          onClick={() => {
            // At the limit it says so when tried (it stays in the row: removing a link puts the focus here).
            if (rows.length >= MAX_LINKS) {
              toast.info(`Up to ${MAX_LINKS} ${legend.toLowerCase()}`);
              return;
            }
            const key = Math.max(-1, ...rows.map((row) => row.key)) + 1;
            setRows([...rows, { label: "", url: "", key }]);
            setAdded(key);
          }}
        >
          <PlusIcon />
          Add
        </Button>
      </SettingRow>
      {rows.length > 0 && (
        <ul className="flex flex-col gap-2 px-4 pb-3.5 @min-[34rem]/settings:px-5">
          {rows.map((row, i) => (
            <li key={row.key} className="flex items-center gap-2">
              <Input
                name={`${name}Label`}
                aria-label={`${item} ${i + 1} label`}
                placeholder="Label"
                defaultValue={row.label}
                maxLength={40}
                autoComplete="off"
                autoFocus={row.key === added}
                // Narrower in the settings column at its narrowest, so the URL keeps room.
                className="w-24 shrink-0 @min-[20rem]/settings:w-32"
              />
              <Input name={`${name}Url`} type="url" aria-label={`${item} ${i + 1} URL`} placeholder="https://" defaultValue={row.url} autoComplete="off" className="min-w-0 flex-1" />
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                aria-label={`Remove ${item.toLowerCase()} ${i + 1}`}
                title="Remove"
                onClick={() => {
                  // Remove goes with its link: focus moves to "Add", not out of the page.
                  addButton.current?.focus();
                  setRows(rows.filter((r) => r.key !== row.key));
                }}
              >
                <XIcon />
              </Button>
            </li>
          ))}
        </ul>
      )}
    </fieldset>
  );
}

/**
 * An uploaded image's state, for a field that shows it (ImageField, the changelog's featured image): `inputs` are its
 * upload id in a hidden field (`name`, empty when removed; a change event when it changes) and the file input `id`
 * that `pick` opens; `drop` goes on where an image may be dropped (not in a disabled fieldset: a setting the plan
 * doesn't include, its file input and buttons off there too).
 */
export function useImageUpload({
  projectSlug,
  name,
  id,
  label,
  image: initial,
  onBusy,
}: {
  /** Where uploads go; without one, the image can only be removed. */
  projectSlug?: string;
  name: string;
  id: string;
  /** The file input's name, for a field with no label pointing at `id`. */
  label?: string;
  image: Image;
  onBusy: (delta: number) => void;
}) {
  const [image, setImage] = useState(initial);
  const trpc = useTRPCClient();
  const [status, setStatus] = useState<{ uploading: true } | { error: string } | null>(null);
  const field = useRef<HTMLInputElement>(null);
  const picker = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  useFieldChanged(field, image);

  // One at a time: Upload and dropping wait while one is on its way, so every upload's onBusy(1) has its onBusy(-1)
  // and none is left behind by a newer one (a form waiting on onBusy, like the changelog's Save, would wait for good).
  const uploading = status !== null && "uploading" in status;
  const upload = async (file: File) => {
    if (uploading || !projectSlug) {
      return;
    }
    setStatus({ uploading: true });
    onBusy(1);
    // A server action that fails (the network drops, a deploy lands) rejects: the upload still ends, with an error.
    const result = await uploadImage(trpc, projectSlug, file)
      .catch(() => ({ error: "The upload failed. Try again." }))
      .finally(() => onBusy(-1));
    if ("error" in result) {
      setStatus(result);
      return;
    }
    setImage({ id: result.mediaId, url: result.src });
    setStatus(null);
  };

  const drop = {
    onDragOver: (event: React.DragEvent<HTMLElement>) => {
      event.preventDefault();
      setDragging(!uploading && !event.currentTarget.closest("fieldset:disabled"));
    },
    onDragLeave: () => setDragging(false),
    onDrop: (event: React.DragEvent<HTMLElement>) => {
      event.preventDefault();
      setDragging(false);
      if (event.currentTarget.closest("fieldset:disabled")) {
        return;
      }
      const file = event.dataTransfer.files[0];
      if (file) {
        void upload(file);
      }
    },
  };

  const inputs = (
    <>
      <input ref={field} type="hidden" name={name} value={image?.id ?? ""} />
      {/* For the preview only (saveBranding reads the id). */}
      <input type="hidden" name={`${name}Url`} value={image?.url ?? ""} />
      {/* Opened by pick (the file input itself stays out of sight and out of the tab order). */}
      <input
        ref={picker}
        id={id}
        aria-label={label}
        type="file"
        tabIndex={-1}
        disabled={uploading || !projectSlug}
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
    </>
  );

  return { image, setImage, uploading, error: status && "error" in status ? status.error : null, dragging, drop, inputs, pick: () => picker.current?.click() };
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
  /** Where uploads go; without one, the image can only be removed (Account's photo for someone without a project). */
  projectSlug?: string;
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
  const uploadButton = useRef<HTMLButtonElement>(null);
  const { image, setImage, uploading, error, dragging, drop, inputs, pick } = useImageUpload({ projectSlug, name, id, image: initial, onBusy });

  return (
    <Field>
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      {/* Dropped here, or picked with "Upload". */}
      <div {...drop} className={cn("flex flex-wrap items-center gap-3 rounded-lg border border-dashed p-3 transition-colors", dragging && "border-primary bg-soft")}>
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
              // Off while one uploads (or without a project to upload into), yet focusable (aria-disabled): focus stays here through the upload, "Uploading…" read below.
              disabled={uploading || !projectSlug}
              focusableWhenDisabled
              // The description says why it's off, when it is (Account's photo without a project).
              aria-describedby={`${id}-description`}
              ref={uploadButton}
              onClick={pick}
            >
              <UploadIcon />
              Upload
            </Button>
            {image && (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                // Off while one uploads (its image would come back after), focusable all the same.
                disabled={uploading}
                focusableWhenDisabled
                onClick={() => {
                  // Remove goes with the image: focus moves to Upload, not out of the field.
                  uploadButton.current?.focus();
                  setImage(null);
                  onRemove?.();
                }}
              >
                Remove
              </Button>
            )}
          </div>
          {projectSlug && <span className="text-xs text-muted-foreground">or drop an image here</span>}
        </div>
        {inputs}
      </div>
      <FieldDescription id={`${id}-description`}>{description}</FieldDescription>
      {uploading && (
        <p role="status" className="text-sm text-muted-foreground">
          Uploading…
        </p>
      )}
      {error && <FieldError>{error}</FieldError>}
    </Field>
  );
}


/** The licence's line, and the start of the toast when a check finds one: one wording and one date for both. */
const licensedLine = (until: Date) => `Licensed until ${formatDate(until)}.`;

/** What hiding the badge takes where plans are sold (tuti.so): the add-on on the project's plan, bought on Billing. */
type BadgePlan = { addOn: boolean; billingUrl: string; perMonth: number | null };

/**
 * Settings → Branding's last row, in its form (see branding.update): "Powered by tuti" in the footer, on unless the
 * project has a licence (or the add-on on its plan). Without one, switching it off opens a dialog instead: why the
 * badge matters, and where to buy a licence (and Check now), or where plans are sold, the add-on on Billing. What it
 * takes to hide is behind the row's ⓘ; a licence's date and the add-on's state show under the label.
 *
 * The form sends the switch only while it differs from what's saved (`poweredBy`: "on" or "off", else empty): saving a
 * colour from a page opened before the badge was hidden elsewhere (Billing's add-on, another tab) leaves the badge as
 * it is, and the switch then shows what's saved.
 */
export function PoweredBySettings({
  projectSlug,
  poweredBy,
  licensedUntil: initial,
  buyLicenseUrl,
  plan,
}: {
  projectSlug: string;
  poweredBy: boolean;
  /** When the project's licence expires; null without one. */
  licensedUntil: Date | null;
  /** tuti.so/app/license for this installation and project. */
  buyLicenseUrl: string;
  /** Where plans are sold; null elsewhere. */
  plan: BadgePlan | null;
}) {
  // What was picked here, until the page says that's what's saved (after each save it says again): a pick made while
  // another was being saved stays one to save. With none, the switch shows what's saved, changed elsewhere or not.
  const [choice, setShown] = useState<boolean | null>(null);
  const [saved, setSaved] = useState(poweredBy);
  if (saved !== poweredBy) {
    setSaved(poweredBy);
    if (choice === poweredBy) {
      setShown(null);
    }
  }
  const shown = choice ?? saved;
  const change = shown === saved ? "" : shown ? "on" : "off";
  const id = useId();
  // The form's field: it says when the change is made, taken back or saved, for "Save changes".
  const field = useRef<HTMLInputElement>(null);
  useFieldChanged(field, change);
  // The preview shows it as it's switched (the form's own draft only has what it sends).
  const { setDraft, saving } = usePreview();
  useEffect(() => setDraft({ poweredBy: shown }), [setDraft, shown]);
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
    setShown(!saving && !saved ? null : false);
    setOpen(false);
    toast.success(`${licensedLine(outcome.licensedUntil)} Save your changes to hide the badge.`);
  };

  // Live: switching it back on with the add-on says it's still billed, and where it's removed.
  const status = plan?.addOn ? (
    <span aria-live="polite">
      {shown ? <>The add-on is still on this project&apos;s plan: remove it in <Link href={plan.billingUrl} className="underline underline-offset-4 hover:text-foreground">Billing</Link>.</> : "Hidden with the add-on on this project's plan."}
    </span>
  ) : licensedUntil ? (
    licensedLine(licensedUntil)
  ) : undefined;
  // What hiding it takes, without either: behind the ⓘ, and the switch's description for screen readers.
  const needs = status ? null : plan ? "Hiding it is an add-on to a paid plan." : "Hiding it needs a licence for this project.";

  return (
    <div id="powered-by" className="scroll-mt-4">
      {/* `data-saved`: what the page last said is saved, whatever is picked (a journey waits on it). */}
      <input ref={field} type="hidden" name="poweredBy" value={change} data-saved={saved ? "on" : "off"} />
      <SettingRow
        label={'"Powered by tuti"'}
        htmlFor={id}
        description={status}
        info={`The badge at the foot of your portal.${needs ? ` ${needs}` : ""}`}
        inline
      >
        <Switch
          id={id}
          checked={shown}
          aria-describedby={status ? `${id}-description` : `${id}-needs`}
          onChange={(event) => {
            if (!event.target.checked && !licensedUntil && !plan?.addOn) {
              setMessage(null);
              setOpen(true);
              return;
            }
            // Switched back to what's saved, the pick is forgotten: a change made elsewhere then shows, and a later
            // save doesn't undo it. Not while a save runs: "what's saved" is about to change, and a pick made then
            // has to stay one to save.
            setShown(!saving && event.target.checked === saved ? null : event.target.checked);
          }}
        />
      </SettingRow>
      {needs && (
        <span id={`${id}-needs`} className="sr-only">
          {needs}
        </span>
      )}
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
            <p className="text-sm">{plan.perMonth === null
                ? "Hiding it isn't sold for this project's plan here."
                : `To remove it from this project, add it to its plan in Billing: $${plan.perMonth} a month, on a paid plan.`}</p>
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
    </div>
  );
}
