"use client";

import { cn } from "cn";
import { FileUpIcon } from "lucide-react";
import { useRouter } from "next/navigation";
import { type FormEvent, useEffect, useRef, useState, useTransition } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { SPEC_TOO_LARGE } from "@/lib/api-reference";
import { addApiReference } from "@/server/docs";

/** Where focus goes when the server refuses an add, by the field its reason is about and shown under. */
const FOCUS = { spec: "api-reference-file-button", name: "api-reference-name", tab: "api-reference-tab" } as const;

/** A spec as a source gives it: its text, and the name it suggests for the reference. */
type Spec = { text: string; suggests: string };

/**
 * The spec from a file: picked or dropped, read here as text. The readers load when a file is chosen
 * (they're large), and say at once what the server would: a file that's too large or isn't a spec.
 */
function UploadSource({ error, onChange }: { error?: string; onChange: (spec: Spec | null, error?: string) => void }) {
  const picker = useRef<HTMLInputElement>(null);
  const [fileName, setFileName] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  // The latest file chosen: one still being read when another is picked is dropped.
  const latest = useRef(0);

  async function choose(file: File | undefined) {
    if (!file) {
      return;
    }
    const turn = ++latest.current;
    setFileName(file.name);
    onChange(null);
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
 * open. Its spec comes from a source: a file, for now. Another (a URL, a repository) is a panel like
 * UploadSource, giving its spec the same way, and a chooser between them above it.
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
  const [spec, setSpec] = useState<Spec | null>(null);
  // What's wrong, and the field it's about: shown under it.
  const [error, setError] = useState<{ field: keyof typeof FOCUS; message: string }>();
  const tabItems = tabs.map((tab) => ({ value: tab.slug, label: tab.name }));
  // Without tabs there's no Tab field: what's wrong with the tab (the last one, deleted since the dialog opened; the
  // page is refreshed after that refusal, and it's gone then) is said under the file.
  const shown = error?.field === "tab" && tabItems.length === 0 ? "spec" : error?.field;
  const about = (field: keyof typeof FOCUS) => (shown === field ? error?.message : undefined);
  // How many adds the server refused: after each, focus goes to the field the reason is about, once it's shown
  // (the field is described by it).
  const [refused, setRefused] = useState(0);
  useEffect(() => {
    if (refused > 0 && shown) {
      document.getElementById(FOCUS[shown])?.focus();
    }
    // As a refusal arrives (its reason is set with it), and again if its field goes and the reason moves.
  }, [refused, shown]);
  // Its name: the spec's until the team types one.
  const [name, setName] = useState("");
  // A ref: a file chosen before the team typed is still being read when they do.
  const named = useRef(false);
  const [picked, setTab] = useState<string | null>(defaultTab ?? tabItems[0]?.value ?? null);
  // A tab deleted while the dialog is open leaves the list (the page follows live): the first one, then.
  const tab = tabItems.some((item) => item.value === picked) ? picked : (tabItems[0]?.value ?? null);

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    // The button stays focusable while it's off, and Enter in Name submits too.
    if (!spec || pending || !name.trim()) {
      return;
    }
    const formData = new FormData(event.currentTarget);
    // As a file: a form's text has its line breaks rewritten on the way (to CRLF), and the spec is kept as it was written.
    formData.set("spec", new Blob([spec.text]));
    setError(undefined);
    startTransition(async () => {
      const result = await addApiReference(projectSlug, formData);
      if (result.slug) {
        onClose();
        toast.success("API reference added");
        router.push(`/app/${projectSlug}/docs/references/${result.slug}`);
      } else if (result.error) {
        setError({ field: result.field ?? "spec", message: result.error });
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
        </DialogHeader>
        <form onSubmit={submit}>
          <FieldGroup>
            <UploadSource
              error={about("spec")}
              onChange={(next, problem) => {
                setSpec(next);
                // A new file answers what was wrong with the last one; what's wrong with the name or the tab stays.
                setError((was) => (problem ? { field: "spec", message: problem } : was?.field === "spec" ? undefined : was));
                if (next && !named.current) {
                  setName(next.suggests.slice(0, 80));
                }
              }}
            />
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
