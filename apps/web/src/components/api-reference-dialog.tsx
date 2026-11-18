"use client";

import { cn } from "cn";
import { FileUpIcon, LinkIcon, UploadIcon } from "lucide-react";
import { useRouter } from "next/navigation";
import { type FormEvent, useEffect, useRef, useState, useTransition } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { SPEC_TOO_LARGE } from "@/lib/api-reference";
import { previewApiReferenceUrl } from "@/server/api-references";
import { addApiReference } from "@/server/docs";

/** Where focus goes when the server refuses an add, by the field its reason is about and shown under. */
const FOCUS = { spec: "api-reference-file-button", url: "api-reference-url", name: "api-reference-name", tab: "api-reference-tab" } as const;

/** A spec as a source gives it: its text (a file) or its address (a URL), and the name it suggests for the reference. */
type Spec = { text: string; suggests: string } | { url: string; suggests: string };

/** Where a spec can live, in the chooser's order. */
const SOURCES = [
  { value: "url", label: "From a URL", description: "An OpenAPI spec or GraphQL schema. Fetched every 6 hours", icon: LinkIcon },
  { value: "upload", label: "Upload a file", description: "OpenAPI (JSON or YAML) or a GraphQL schema file", icon: UploadIcon },
] as const;
type Source = (typeof SOURCES)[number]["value"];

/**
 * The spec at an address: "Fetch" reads it on the server as adding it will (https, public addresses, 5 MB), says
 * what's wrong at once, and suggests its name. Another address typed asks for Fetch again.
 */
function UrlSource({
  projectSlug,
  error,
  onChange,
  onReading,
}: {
  projectSlug: string;
  error?: string;
  onChange: (spec: Spec | null, error?: string) => void;
  /** A read starting (1), and its answer handled, kept or dropped (-1): the dialog says while any is unsettled. */
  onReading: (by: 1 | -1) => void;
}) {
  const [url, setUrl] = useState("");
  const [pending, startTransition] = useTransition();
  const [fetched, setFetched] = useState<string | null>(null);
  // The latest Fetch: an answer for an address typed over since, or one arriving after the team picked another source
  // (this panel gone), is dropped.
  const latest = useRef(0);
  useEffect(
    () => () => {
      latest.current++;
    },
    [],
  );
  // The address a Fetch is on its way for: Enter again (or held down) for it waits for its answer, rather than asking
  // again. Cleared as the answer arrives, before it shows, so a Fetch once it's answered (an error, say) goes at once.
  const asking = useRef<string | null>(null);
  const fetchIt = () => {
    const address = url.trim();
    // Another address goes even while one is on its way, and `latest` drops the older's answer.
    if (!address || asking.current === address) {
      return;
    }
    asking.current = address;
    const turn = ++latest.current;
    onReading(1);
    startTransition(async () => {
      const result = await previewApiReferenceUrl(projectSlug, address).catch(() => ({ error: "Couldn't read that address. Try again.", suggests: undefined }));
      if (asking.current === address) {
        asking.current = null;
      }
      // Handled, kept or dropped: in the same update as what it changed.
      onReading(-1);
      if (turn !== latest.current) {
        return;
      }
      if (result.error || result.suggests === undefined) {
        onChange(null, result.error ?? "Couldn't read that address. Try again.");
      } else {
        setFetched(address);
        onChange({ url: address, suggests: result.suggests });
      }
    });
  };
  return (
    <Field data-invalid={error ? true : undefined}>
      <FieldLabel htmlFor={FOCUS.url}>Spec URL</FieldLabel>
      <div className="flex gap-2">
        <Input
          id={FOCUS.url}
          type="url"
          inputMode="url"
          value={url}
          placeholder="https://example.com/openapi.json"
          maxLength={2000}
          onChange={(event) => {
            setUrl(event.target.value);
            latest.current++;
            // An edit asks again, even for the address on its way: its answer is dropped now.
            asking.current = null;
            if (fetched !== null) {
              setFetched(null);
              onChange(null);
            }
          }}
          onKeyDown={(event) => {
            // Enter reads the address rather than adding a reference not read yet.
            if (event.key === "Enter" && fetched === null) {
              event.preventDefault();
              fetchIt();
            }
          }}
          aria-invalid={error ? true : undefined}
          aria-describedby="api-reference-url-note"
        />
        <Button type="button" variant="outline" disabled={pending || !url.trim()} focusableWhenDisabled onClick={fetchIt}>
          {pending ? "Fetching…" : "Fetch"}
        </Button>
      </div>
      {error ? (
        <FieldError id="api-reference-url-note">{error}</FieldError>
      ) : (
        <FieldDescription id="api-reference-url-note" aria-live="polite">
          {fetched ? "Read. It’s fetched again every 6 hours." : "A public https address. Fetch reads it and suggests a name."}
        </FieldDescription>
      )}
    </Field>
  );
}

/**
 * The spec from a file: picked or dropped, read here as text. The readers load when a file is chosen
 * (they're large), and say at once what the server would: a file that's too large or isn't a spec.
 */
function UploadSource({ error, onChange, onReading }: { error?: string; onChange: (spec: Spec | null, error?: string) => void; onReading: (by: 1 | -1) => void }) {
  const picker = useRef<HTMLInputElement>(null);
  const [fileName, setFileName] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  // The latest file chosen: one still being read when another is picked, or when the team picks another source (this
  // panel gone), is dropped.
  const latest = useRef(0);
  useEffect(
    () => () => {
      latest.current++;
    },
    [],
  );

  async function choose(file: File | undefined) {
    if (!file) {
      return;
    }
    const turn = ++latest.current;
    setFileName(file.name);
    onChange(null);
    onReading(1);
    try {
      const { OPENAPI_MAX_BYTES, readSpec } = await import("@tuti/shared/api-reference");
      // ponytail: read on the main thread, which a spec near 5 MB holds for a moment; a worker if that's felt.
      const text = file.size > OPENAPI_MAX_BYTES ? null : await file.text();
      const read = text === null ? { error: SPEC_TOO_LARGE } : readSpec(text);
      if (turn !== latest.current) {
        return;
      }
      if (text === null || "error" in read) {
        onChange(null, "error" in read ? read.error : undefined);
      } else {
        onChange({ text, suggests: read.doc.title || file.name.replace(/\.[^.]+$/, "") });
      }
    } catch {
      // The readers didn't load (a release since the page did, the network), or the file changed or went since it was
      // chosen: said under the field, like a file that isn't a spec.
      if (turn === latest.current) {
        onChange(null, "This file couldn't be read. Reload the page and try again.");
      }
    } finally {
      // Handled, kept or dropped: in the same update as what it changed.
      onReading(-1);
    }
  }

  return (
    <Field data-invalid={error ? true : undefined}>
      <FieldLabel htmlFor="api-reference-file">Spec file</FieldLabel>
      {/* Opened by the button (the file input itself stays out of sight and out of the tab order). */}
      <input
        ref={picker}
        id="api-reference-file"
        type="file"
        tabIndex={-1}
        accept=".json,.yaml,.yml,.graphql,.gql"
        className="sr-only"
        onChange={(event) => {
          void choose(event.target.files?.[0]);
          event.target.value = "";
        }}
      />
      <button
        id={FOCUS.spec}
        type="button"
        // What it reads, or why the file chosen was refused: whichever is under it.
        aria-describedby="api-reference-file-note"
        onClick={() => picker.current?.click()}
        onDragOver={(event) => {
          event.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(event) => {
          event.preventDefault();
          setDragging(false);
          void choose(event.dataTransfer.files[0]);
        }}
        className={cn(
          "flex min-h-24 flex-col items-center justify-center gap-1.5 rounded-lg border border-dashed px-4 py-5 text-sm outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring",
          dragging && "border-primary bg-accent",
          error && "border-destructive",
        )}
      >
        <FileUpIcon aria-hidden className="size-5 text-muted-foreground" />
        {fileName ? (
          <>
            <span className="max-w-full truncate font-medium">{fileName}</span>
            <span className="text-muted-foreground">Choose another file</span>
          </>
        ) : (
          <span>Drop your spec here, or choose a file</span>
        )}
      </button>
      {error ? <FieldError id="api-reference-file-note">{error}</FieldError> : <FieldDescription id="api-reference-file-note">OpenAPI 3.0 or 3.1 (JSON or YAML), or a GraphQL schema</FieldDescription>}
    </Field>
  );
}

/**
 * Adds an API reference to tab `defaultTab` (see apiReferences.create): the dialog the docs' "+" menus
 * open. Its spec comes from a source, picked above: an address (UrlSource) or a file (UploadSource).
 * Another (a repository) is one more panel giving its spec the same way, and one more choice.
 */
export function ApiReferenceDialog({
  projectSlug,
  tabs,
  defaultTab,
  onClose,
}: {
  projectSlug: string;
  /** The tabs it can go in. */
  tabs: { slug: string; name: string }[];
  defaultTab?: string;
  onClose: () => void;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [source, setSource] = useState<Source>("url");
  const [spec, setSpec] = useState<Spec | null>(null);
  // What's wrong, and the field it's about: shown under it.
  const [error, setError] = useState<{ field: keyof typeof FOCUS; message: string }>();
  const tabItems = tabs.map((tab) => ({ value: tab.slug, label: tab.name }));
  // Without tabs there's no Tab field: what's wrong with the tab (the last one, deleted since the dialog opened; the
  // page is refreshed after that refusal, and it's gone then) is said under the file.
  const shown = error?.field === "tab" && tabItems.length === 0 ? (source === "url" ? "url" : "spec") : error?.field;
  const about = (field: keyof typeof FOCUS) => (shown === field ? error?.message : undefined);
  // How many adds the server refused: after each, focus goes to the field the reason is about, once it's shown
  // (the field is described by it).
  const [refused, setRefused] = useState(0);
  // The refusals focus has gone to.
  const answered = useRef(0);
  useEffect(() => {
    if (refused === 0 || !shown) {
      return;
    }
    // As a refusal arrives (its reason is set with it). When its field goes and the reason moves, only if focus went
    // with the field (it's on nothing in the form now): someone typing in another field is left there.
    const fresh = refused > answered.current;
    answered.current = refused;
    if (fresh || !document.activeElement?.closest("form")) {
      document.getElementById(FOCUS[shown])?.focus();
    }
  }, [refused, shown]);
  // Its name: the spec's until the team types one.
  const [name, setName] = useState("");
  // A ref: a file chosen before the team typed is still being read when they do.
  const named = useRef(false);
  const [picked, setTab] = useState<string | null>(defaultTab ?? tabItems[0]?.value ?? null);
  // A tab deleted while the dialog is open leaves the list (the page follows live): the first one, then.
  const tab = tabItems.some((item) => item.value === picked) ? picked : (tabItems[0]?.value ?? null);

  /** A source's spec, or what's wrong with it, said under its field. */
  const chosen = (field: "spec" | "url") => (next: Spec | null, problem?: string) => {
    setSpec(next);
    // A new spec answers what was wrong with the last one; what's wrong with the name or the tab stays.
    setError((was) => (problem ? { field, message: problem } : was?.field === field ? undefined : was));
    if (next && !named.current) {
      setName(next.suggests.slice(0, 80));
    }
  };

  // Reads a source has started whose answers aren't handled yet (a panel switched away from still counts until its answer
  // is dropped): the form says so (`data-reading`), which tests wait on.
  const [unsettled, setUnsettled] = useState(0);
  const reading = (by: 1 | -1) => setUnsettled((count) => count + by);

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    // The button stays focusable while it's off, and Enter in Name submits too.
    if (!spec || pending || !name.trim()) {
      return;
    }
    const formData = new FormData(event.currentTarget);
    if ("url" in spec) {
      formData.set("url", spec.url);
    } else {
      // As a file: a form's text has its line breaks rewritten on the way (to CRLF), and the spec is kept as it was written.
      formData.set("spec", new Blob([spec.text]));
    }
    setError(undefined);
    startTransition(async () => {
      const result = await addApiReference(projectSlug, formData);
      if (result.slug) {
        onClose();
        toast.success("API reference added");
        router.push(`/app/${projectSlug}/docs/references/${result.slug}`);
      } else if (result.error) {
        setError({ field: result.field ?? ("url" in spec ? "url" : "spec"), message: result.error });
        setRefused((count) => count + 1);
        // The tab is gone: the page's tabs are read again, so the dialog offers the ones there are.
        if (result.field === "tab") {
          router.refresh();
        }
      }
    });
  }

  return (
    <Dialog open onOpenChange={(open) => !open && !pending && onClose()}>
      <DialogContent className="max-h-[calc(100dvh-2rem)] gap-5 overflow-y-auto p-5 sm:max-w-md sm:p-6">
        <DialogHeader>
          <DialogTitle className="text-xl font-semibold">Add API reference</DialogTitle>
          <DialogDescription>Where does your OpenAPI spec or GraphQL schema live? We build a page for each endpoint.</DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} data-reading={unsettled > 0 || undefined}>
          <FieldGroup>
            {/* Native radios: arrow keys move between them. */}
            <div role="radiogroup" aria-label="Where the spec is" className="flex flex-col gap-2">
              {SOURCES.map(({ value, label, description, icon: Icon }) => (
                <label
                  key={value}
                  className="flex cursor-pointer items-center gap-3 rounded-lg border px-3 py-2.5 hover:bg-muted has-checked:border-primary has-checked:bg-soft has-focus-visible:ring-2 has-focus-visible:ring-ring/50"
                >
                  <input
                    type="radio"
                    name="source"
                    value={value}
                    className="sr-only"
                    checked={source === value}
                    disabled={pending}
                    onChange={() => {
                      setSource(value);
                      // Each panel starts empty: what the other read isn't this one's.
                      setSpec(null);
                      setError((was) => (was?.field === "spec" || was?.field === "url" ? undefined : was));
                    }}
                  />
                  <span aria-hidden className="grid size-8 shrink-0 place-items-center rounded-md bg-muted text-muted-foreground">
                    <Icon className="size-4" />
                  </span>
                  <span className="flex min-w-0 flex-col">
                    <span className="text-sm font-medium">{label}</span>
                    <span className="text-xs text-muted-foreground">{description}</span>
                  </span>
                </label>
              ))}
            </div>
            {source === "url" ? (
              <UrlSource key="url" projectSlug={projectSlug} error={about("url")} onChange={chosen("url")} onReading={reading} />
            ) : (
              <UploadSource key="upload" error={about("spec")} onChange={chosen("spec")} onReading={reading} />
            )}
            <Field data-invalid={about("name") ? true : undefined}>
              <FieldLabel htmlFor={FOCUS.name}>Name</FieldLabel>
              <Input
                id={FOCUS.name}
                name="name"
                value={name}
                onChange={(event) => {
                  setName(event.target.value);
                  named.current = event.target.value !== "";
                  // Another name answers what was wrong with the last; what's wrong with the file stays.
                  setError((was) => (was?.field === "name" ? undefined : was));
                }}
                placeholder="API reference"
                maxLength={80}
                required
                aria-invalid={about("name") ? true : undefined}
                aria-describedby={about("name") ? "api-reference-name-error" : undefined}
              />
              {about("name") && <FieldError id="api-reference-name-error">{about("name")}</FieldError>}
            </Field>
            {tabItems.length > 0 && (
              <Field data-invalid={about("tab") ? true : undefined}>
                <FieldLabel id="api-reference-tab-label">Tab</FieldLabel>
                <Select
                  name="tab"
                  items={tabItems}
                  value={tab}
                  // Its reason stays until Add is pressed again: the page is refreshed after its refusal, and a tab that's
                  // gone leaves the list then, which changes the value by itself.
                  onValueChange={(value) => setTab(value as string | null)}
                >
                  <SelectTrigger
                    id={FOCUS.tab}
                    className="w-full"
                    aria-labelledby="api-reference-tab-label"
                    aria-invalid={about("tab") ? true : undefined}
                    aria-describedby={about("tab") ? "api-reference-tab-error" : undefined}
                  >
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {tabItems.map((item) => (
                      <SelectItem key={item.value} value={item.value}>
                        {item.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {about("tab") && <FieldError id="api-reference-tab-error">{about("tab")}</FieldError>}
              </Field>
            )}
            <DialogFooter className="-mx-5 -mb-5 mt-1 bg-transparent px-5 pt-4 pb-5 sm:-mx-6 sm:-mb-6 sm:px-6 sm:pb-6">
              <Button type="button" variant="outline" disabled={pending} focusableWhenDisabled onClick={onClose}>
                Cancel
              </Button>
              {/* Focusable while it's off: focus stays on it as it adds. */}
              <Button type="submit" disabled={pending || !spec || !name.trim()} focusableWhenDisabled>
                {pending ? "Adding…" : "Add reference"}
              </Button>
            </DialogFooter>
          </FieldGroup>
        </form>
      </DialogContent>
    </Dialog>
  );
}
