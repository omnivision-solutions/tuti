"use client";

import type { MediaUrls } from "@tuti/content";
import { MAX_IMAGE_SIZE, UPLOAD_IMAGE_TYPES } from "@tuti/content/media";
import { cn } from "cn";
import { DownloadIcon, ImageIcon, LoaderCircleIcon, PlusIcon, SparklesIcon, XIcon } from "lucide-react";
import { useEffect, useId, useRef, useState, useTransition } from "react";
import { flushSync } from "react-dom";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { FieldError, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { MAX_IMAGE_PROMPT, MAX_IMAGE_REFERENCES, MIN_GENERATED_SIDE } from "@/lib/image-limits";
import { uploadImage } from "@/lib/upload-image";
import { generateImage } from "@/server/images";
import { uploadStatus } from "@/server/media";


/** A finished upload: its id and a link to show it. */
export type PickedImage = { id: string; url: string };
/** An image made in the dialog, as used: its full size (a signed link, fresh when used), and every stored size (for an editor that inserts it). */
export type GeneratedImage = PickedImage & { width: number; height: number; urls: MediaUrls };
/** A try: a lasting link to its 480px size, which doesn't expire while the dialog keeps it. */
export type Try = PickedImage & { width: number; height: number };
/** What an editor needs for "Edit with AI" on its images: AI credits are on, the project is out of them, its logo. */
export type ImageEditing = { credits: boolean; paused: boolean; logo: PickedImage | null };
export type ImageSize = { label: string; width: number; height: number };

const PRESETS: ImageSize[] = [
  { label: "16:9", width: 1600, height: 900 },
  { label: "1:1", width: 1200, height: 1200 },
  { label: "4:5", width: 1200, height: 1500 },
];
const CUSTOM = "Custom";

const fits = (side: number) => Number.isInteger(side) && side >= MIN_GENERATED_SIDE && side <= MAX_IMAGE_SIZE;

/** A size's shape, small, before its name. */
function RatioGlyph({ width, height }: { width?: number; height?: number }) {
  const wide = !width || !height || width >= height;
  return (
    <span aria-hidden className="flex size-4 items-center justify-center">
      <span
        className={cn("rounded-[2px] border-[1.5px] border-current", !width && "border-dashed", wide ? "w-4" : "h-4")}
        style={{ aspectRatio: width && height ? `${width} / ${height}` : "1 / 1" }}
      />
    </span>
  );
}

/**
 * "Generate image" (docs/plan.md, AI image generator): a prompt, up to 14 of the project's images to work from and a
 * size make one image with AI (images.generate); each try is kept while the dialog's owner is there, to pick one and use it
 * (shown by its lasting link; Use and Download ask for fresh signed links to the full size).
 */
export function ImageGenerator({
  projectSlug,
  open,
  onOpenChange,
  title = "Generate image",
  subtitle,
  defaultSize,
  references: initialReferences = [],
  fromHere,
  logo,
  credits,
  useLabel,
  onUse,
  alsoUse,
  editing,
  tries: initialTries = [],
  onTries,
  finalFocus,
}: {
  projectSlug: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title?: string;
  /** What it's for, beside the title ("Cover for “…”"). */
  subtitle?: string;
  /** The first size offered, and the one picked to start ("Cover", 1200 × 630). */
  defaultSize: ImageSize;
  /** Picked to start with: an image being edited goes first. */
  references?: PickedImage[];
  /** "From this entry": the images of what it's made for. */
  fromHere?: { label: string; images: PickedImage[] };
  /** The project's brand logo, if it has one. */
  logo?: PickedImage | null;
  /** AI credits are on: said beside Generate. */
  credits?: boolean;
  /** The result's main action ("Use as cover"). */
  useLabel: string;
  onUse: (image: GeneratedImage) => void;
  /** A second action on the result, beside the main one ("Insert as new"). */
  alsoUse?: { label: string; onUse: (image: GeneratedImage) => void };
  /** The image being edited ("Edit with AI"): the first reference, kept there, and shown beside each try. */
  editing?: Try;
  /** Tries made before (kept by the owner, as `onTries` gives them), the last one picked. */
  tries?: Try[];
  /** Each new try, with those before it: for the owner to keep while the dialog isn't there. */
  onTries?: (tries: Try[]) => void;
  finalFocus?: Parameters<typeof DialogContent>[0]["finalFocus"];
}) {
  const id = useId();
  const promptRef = useRef<HTMLTextAreaElement>(null);
  const picker = useRef<HTMLInputElement>(null);
  const addRef = useRef<HTMLButtonElement>(null);
  // Closed while Use or Download waited for its link: neither happens then.
  const openRef = useRef(open);
  useEffect(() => {
    openRef.current = open;
  }, [open]);
  const [prompt, setPrompt] = useState("");
  const [references, setReferences] = useState(editing ? [editing, ...initialReferences.filter((each) => each.id !== editing.id)] : initialReferences);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const sizes = [defaultSize, ...PRESETS];
  const [sizeLabel, setSizeLabel] = useState(defaultSize.label);
  const [custom, setCustom] = useState({ width: String(defaultSize.width), height: String(defaultSize.height) });
  const [tries, setTries] = useState<Try[]>(initialTries);
  // What the live region says once a try is in (while one runs, Generating…; errors are an alert of their own).
  const [said, setSaid] = useState("");
  const [using, startUsing] = useTransition();
  const [useError, setUseError] = useState<string | null>(null);
  // The try the edited image is (one placed before), or the last.
  const [selected, setSelected] = useState(() => {
    const placed = initialTries.findIndex((each) => each.id === editing?.id);
    return placed >= 0 ? placed : Math.max(0, initialTries.length - 1);
  });
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const preset = sizes.find((size) => size.label === sizeLabel);
  const size = preset ?? { width: Number(custom.width), height: Number(custom.height) };
  const sizeOk = fits(size.width) && fits(size.height);
  // An upload still running counts: its image joins the list when it's done.
  const full = references.length + (uploading ? 1 : 0) >= MAX_IMAGE_REFERENCES;
  const shown = tries[selected];

  // The image being edited stays first: "first" is after it.
  const pinned = editing ? 1 : 0;
  const add = (image: PickedImage, first = false) =>
    setReferences((list) => {
      if (image.id === editing?.id) {
        return list;
      }
      const rest = list.filter((each) => each.id !== image.id);
      return (first ? [...rest.slice(0, pinned), image, ...rest.slice(pinned)] : [...rest, image]).slice(0, MAX_IMAGE_REFERENCES);
    });
  const upload = async (file: File | undefined) => {
    if (!file || uploading || full) {
      return;
    }
    setUploading(true);
    setUploadError(null);
    const result = await uploadImage(projectSlug, file).catch(() => ({ error: "The upload failed. Try again." }));
    setUploading(false);
    if ("error" in result) {
      setUploadError(result.error);
    } else {
      add({ id: result.mediaId, url: result.src });
    }
  };

  const generate = () =>
    startTransition(async () => {
      setError(null);
      setUseError(null);
      setSaid("");
      const result = await generateImage(projectSlug, { prompt, width: size.width, height: size.height, references: references.map((each) => each.id) }).catch(() => ({
        error: "Couldn't reach Tuti. Try again.",
        image: undefined,
      }));
      if (!result.image) {
        setSaid("");
        setError(result.error ?? "The image couldn't be made. Try again.");
        return;
      }
      const { id: madeId, url, width, height } = result.image;
      // One runs at a time (Generate waits), so the list is still the one it started with.
      const made = [...tries, { id: madeId, url, width, height }];
      setTries(made);
      onTries?.(made);
      setSelected(tries.length);
      setSaid(`Try ${tries.length + 1} is ready`);
    });
  // The full size, signed now (a try may be hours old): to use it, or to save it.
  const fresh = (image: Try, then: (status: { src: string; urls: MediaUrls; download: string }) => void) =>
    startUsing(async () => {
      setUseError(null);
      const status = await uploadStatus(image.id).catch(() => null);
      if (!openRef.current) {
        return;
      }
      if (status && "src" in status) {
        then(status);
      } else {
        setUseError("Couldn't reach Tuti. Try again.");
      }
    });
  // Refining one that isn't a reference yet, at the limit, would drop the last reference.
  const refineFull = shown !== undefined && full && !references.some((each) => each.id === shown.id);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-4xl"
        finalFocus={finalFocus}
        // Pasted or dropped anywhere on it: a reference.
        onPaste={(event) => {
          // Text pasted into a field stays text, even with a picture of it on the clipboard too (Word, spreadsheets).
          const intoField = event.target instanceof HTMLTextAreaElement || event.target instanceof HTMLInputElement;
          if (intoField && event.clipboardData.types.includes("text/plain")) {
            return;
          }
          const file = [...event.clipboardData.files].find((each) => each.type.startsWith("image/"));
          if (file) {
            event.preventDefault();
            void upload(file);
          }
        }}
        // Only files: text dropped into the prompt stays the browser's to drop.
        onDragOver={(event) => event.dataTransfer.types.includes("Files") && event.preventDefault()}
        onDrop={(event) => {
          if (event.dataTransfer.types.includes("Files")) {
            event.preventDefault();
            void upload(event.dataTransfer.files[0]);
          }
        }}
      >
        <DialogHeader>
          <DialogTitle className="flex flex-wrap items-center gap-x-2 wrap-anywhere">
            <SparklesIcon className="size-4 text-primary" aria-hidden />
            {title}
            {subtitle && <span className="font-normal text-muted-foreground">· {subtitle}</span>}
          </DialogTitle>
        </DialogHeader>
        <div className="grid gap-6 md:grid-cols-2">
          <div className="flex min-w-0 flex-col gap-5">
            <div className="flex flex-col gap-2">
              <FieldLabel htmlFor={`${id}-prompt`}>{editing ? "What to change" : "Describe it"}</FieldLabel>
              <Textarea id={`${id}-prompt`} ref={promptRef} value={prompt} onChange={(event) => setPrompt(event.target.value)} maxLength={MAX_IMAGE_PROMPT} rows={4} />
            </div>
            <div className="flex flex-col gap-2" role="group" aria-labelledby={`${id}-references`}>
              <span id={`${id}-references`} className="text-sm font-medium">
                References
              </span>
              <ul className="flex flex-wrap gap-2" aria-label="References">
                {references.map((image, index) => (
                  <li key={image.id} className="relative size-16">
                    {/* eslint-disable-next-line @next/next/no-img-element -- from media storage, already resized */}
                    <img src={image.url} alt={`Reference ${index + 1}`} className="size-16 rounded-lg border object-cover" />
                    {index < pinned ? (
                      <Badge className="absolute inset-x-0.5 bottom-0.5 h-4 px-1 text-[10px]">Editing</Badge>
                    ) : (
                    <button
                      type="button"
                      aria-label={`Remove reference ${index + 1}`}
                      className="absolute -top-1.5 -right-1.5 flex size-5 items-center justify-center rounded-full border bg-background text-muted-foreground hover:text-foreground"
                      onClick={(event) => {
                        // Focus goes to the next one's ×, or to the + tile after the last (the button goes with its image).
                        const item = event.currentTarget.closest("li")!;
                        const next = item.nextElementSibling?.querySelector("button") ?? addRef.current;
                        flushSync(() => setReferences((list) => list.filter((each) => each.id !== image.id)));
                        next?.focus();
                      }}
                    >
                      <XIcon className="size-3" />
                    </button>
                    )}
                  </li>
                ))}
                {uploading && (
                  <li className="flex size-16 items-center justify-center rounded-lg border" role="status" aria-label="Uploading…">
                    <LoaderCircleIcon className="size-4 animate-spin text-muted-foreground" />
                  </li>
                )}
                <li>
                  <DropdownMenu>
                    <DropdownMenuTrigger
                      render={
                        // Off while one uploads or at the limit, focusable all the same: an upload started from its menu keeps focus here.
                        <Button
                          type="button"
                          variant="ghost"
                          ref={addRef}
                          aria-label="Add a reference"
                          disabled={full || uploading}
                          focusableWhenDisabled
                          className="size-16 rounded-lg border border-dashed text-muted-foreground hover:text-foreground [&_svg:not([class*='size-'])]:size-5"
                        />
                      }
                    >
                      <PlusIcon className="size-5" />
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="start" className="w-56">
                      <DropdownMenuItem onClick={() => picker.current?.click()}>Upload or paste</DropdownMenuItem>
                      {fromHere && (
                        <DropdownMenuSub>
                          <DropdownMenuSubTrigger disabled={fromHere.images.length === 0}>{fromHere.label}</DropdownMenuSubTrigger>
                          <DropdownMenuSubContent className="w-auto">
                            <div className="grid grid-cols-3 gap-1">
                              {fromHere.images.map((image, index) => (
                                <DropdownMenuItem key={image.id} className="p-1" aria-label={`Image ${index + 1}`} onClick={() => add(image)}>
                                  {/* eslint-disable-next-line @next/next/no-img-element -- from media storage, already resized */}
                                  <img src={image.url} alt="" className="size-14 rounded-md border object-cover" />
                                </DropdownMenuItem>
                              ))}
                            </div>
                          </DropdownMenuSubContent>
                        </DropdownMenuSub>
                      )}
                      {logo && <DropdownMenuItem onClick={() => add(logo)}>Your logo</DropdownMenuItem>}
                      <DropdownMenuItem disabled>
                        Media library
                        <Badge variant="secondary" className="ml-auto">
                          Soon
                        </Badge>
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </li>
              </ul>
              <input
                ref={picker}
                type="file"
                tabIndex={-1}
                aria-label="Upload a reference"
                accept={UPLOAD_IMAGE_TYPES.join(",")}
                className="sr-only"
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  event.target.value = "";
                  void upload(file);
                }}
              />
              {uploadError ? <FieldError>{uploadError}</FieldError> : <p className="text-xs text-muted-foreground">Logos, screenshots or a picture whose style to match.</p>}
            </div>
            <div className="flex flex-col gap-2" role="group" aria-labelledby={`${id}-size`}>
              <div className="flex items-baseline justify-between gap-2">
                <span id={`${id}-size`} className="text-sm font-medium">
                  Size
                </span>
                {sizeOk && (
                  <span className="text-xs text-muted-foreground tabular-nums">
                    {size.width} × {size.height}
                  </span>
                )}
              </div>
              <div className="flex flex-wrap gap-1.5">
                {[...sizes, { label: CUSTOM, width: 0, height: 0 }].map((each) => (
                  <Button
                    key={each.label}
                    type="button"
                    size="sm"
                    variant={sizeLabel === each.label ? "secondary" : "ghost"}
                    aria-pressed={sizeLabel === each.label}
                    className={cn(sizeLabel === each.label && "ring-1 ring-primary")}
                    onClick={() => {
                      if (each.label === CUSTOM && preset) {
                        setCustom({ width: String(preset.width), height: String(preset.height) });
                      }
                      setSizeLabel(each.label);
                    }}
                  >
                    <RatioGlyph width={each.width || undefined} height={each.height || undefined} />
                    {each.label}
                  </Button>
                ))}
              </div>
              {!preset && (
                <div className="flex items-center gap-2">
                  {(["width", "height"] as const).map((side, index) => (
                    <span key={side} className="contents">
                      {index === 1 && <span aria-hidden>×</span>}
                      <Input
                        type="number"
                        aria-label={side === "width" ? "Width" : "Height"}
                        min={MIN_GENERATED_SIDE}
                        max={MAX_IMAGE_SIZE}
                        step={1}
                        value={custom[side]}
                        aria-invalid={fits(Number(custom[side])) ? undefined : true}
                        onChange={(event) => setCustom((was) => ({ ...was, [side]: event.target.value }))}
                        className="w-24"
                      />
                    </span>
                  ))}
                </div>
              )}
            </div>
          </div>

          <div className="flex min-w-0 flex-col gap-3">
            {/* Always there, so screen readers hear each change: Generating…, then the try that's ready. */}
            <p role="status" className="sr-only">
              {pending ? "Generating, up to half a minute…" : said}
            </p>
            <div className={cn(editing && shown && !pending && !error && "grid grid-cols-2 gap-2")}>
            {editing && shown && !pending && !error && (
              <figure className="flex min-w-0 flex-col gap-1">
                {/* eslint-disable-next-line @next/next/no-img-element -- from media storage */}
                <img src={editing.url} alt="Original" className="w-full rounded-xl border bg-muted object-contain" style={{ aspectRatio: `${editing.width} / ${editing.height}` }} />
                <figcaption className="text-xs text-muted-foreground">Original</figcaption>
              </figure>
            )}
            <figure className="flex min-w-0 flex-col gap-1">
            <div
              className="flex min-h-48 items-center justify-center overflow-hidden rounded-xl border bg-muted"
              style={shown ? { aspectRatio: `${shown.width} / ${shown.height}` } : undefined}
            >
              {pending ? (
                <p className="flex items-center gap-2 p-4 text-sm text-muted-foreground">
                  <LoaderCircleIcon className="size-4 animate-spin" aria-hidden />
                  Generating, up to half a minute…
                </p>
              ) : error ? (
                <p role="alert" className="p-4 text-sm text-destructive-foreground">
                  {error}
                </p>
              ) : shown ? (
                // eslint-disable-next-line @next/next/no-img-element -- from media storage
                <img src={shown.url} alt={`Try ${selected + 1}`} className="size-full object-contain" />
              ) : (
                <ImageIcon className="size-8 text-muted-foreground" aria-hidden />
              )}
            </div>
            {editing && shown && !pending && !error && (
              <figcaption className="text-xs text-muted-foreground">
                Edited · {selected + 1} of {tries.length}
              </figcaption>
            )}
            </figure>
            </div>
            {tries.length > 0 && (
              <>
                <div className="flex flex-col gap-2" role="group" aria-labelledby={`${id}-tries`}>
                  <span id={`${id}-tries`} className="text-sm font-medium">
                    Tries
                  </span>
                  <div className="flex flex-wrap gap-2">
                    {tries.map((each, index) => (
                      <button
                        key={each.id}
                        type="button"
                        aria-label={`Try ${index + 1}`}
                        aria-pressed={index === selected}
                        onClick={() => {
                          setSelected(index);
                          setError(null);
                          setUseError(null);
                        }}
                        className={cn("size-12 overflow-hidden rounded-md border", index === selected && "ring-2 ring-primary")}
                      >
                        {/* eslint-disable-next-line @next/next/no-img-element -- from media storage */}
                        <img src={each.url} alt="" className="size-full object-cover" />
                      </button>
                    ))}
                  </div>
                </div>
                {/* Only with its image shown: not over an error or the next one being made. */}
                {shown && !pending && !error && (
                  <div className="flex flex-wrap justify-end gap-2">
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      disabled={refineFull}
                      focusableWhenDisabled
                      aria-describedby={refineFull ? `${id}-refine-full` : undefined}
                      onClick={() => {
                        add(shown, true);
                        promptRef.current?.focus();
                      }}
                    >
                      Refine this one
                    </Button>
                    {/* An attachment link: the browser saves it and stays here. */}
                    <Button type="button" variant="outline" size="sm" disabled={using} focusableWhenDisabled onClick={() => fresh(shown, ({ download }) => window.location.assign(download))}>
                      <DownloadIcon />
                      Download
                    </Button>
                    {alsoUse && (
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        disabled={using}
                        focusableWhenDisabled
                        onClick={() => fresh(shown, ({ src, urls }) => alsoUse.onUse({ id: shown.id, url: src, width: shown.width, height: shown.height, urls }))}
                      >
                        {alsoUse.label}
                      </Button>
                    )}
                    <Button
                      type="button"
                      size="sm"
                      disabled={using}
                      focusableWhenDisabled
                      onClick={() => fresh(shown, ({ src, urls }) => onUse({ id: shown.id, url: src, width: shown.width, height: shown.height, urls }))}
                    >
                      {useLabel}
                    </Button>
                  </div>
                )}
                {shown && !pending && !error && refineFull && (
                  <p id={`${id}-refine-full`} className="text-right text-xs text-muted-foreground">
                    At most {MAX_IMAGE_REFERENCES} references: remove one to refine
                  </p>
                )}
                {useError && (
                  <p role="alert" className="text-sm text-destructive-foreground">
                    {useError}
                  </p>
                )}
              </>
            )}
          </div>
        </div>
        <DialogFooter className="items-center">
          {credits && <span className="text-xs text-muted-foreground">Uses AI credits</span>}
          {/* The dialog's one primary: Generate until there's an image to use, then the image's own action. */}
          <Button
            type="button"
            variant={shown ? "outline" : "default"}
            disabled={pending || uploading || !prompt.trim() || !sizeOk}
            focusableWhenDisabled
            onClick={generate}
          >
            <SparklesIcon />
            {pending ? "Generating…" : editing && tries.length > 0 ? "Try again" : "Generate"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
