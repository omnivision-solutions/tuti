"use client";

import { useActionState, useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel, FieldLegend, FieldSet } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { type GroupOption, WhoCanRead } from "@/components/who-can-read";
import { type Listing, LISTING_DESCRIPTIONS, LISTING_LABELS, LISTINGS } from "@/lib/article-listing";
import { keepingFields } from "@/lib/forms";
import type { Access } from "@/lib/read-access";
import { saveArticleSettings } from "@/server/docs";
import type { FormState } from "@/server/form-state";

/** A checkbox with its label and a line under it, like "Show the updated date". */
function Toggle({
  name,
  checked,
  onChange,
  label,
  description,
}: {
  name: string;
  checked: boolean;
  /** Controlled when given; otherwise `checked` is where it starts. */
  onChange?: (checked: boolean) => void;
  label: string;
  description: string;
}) {
  return (
    <label className="flex items-start gap-2">
      <input
        type="checkbox"
        name={name}
        className="mt-1 size-4 shrink-0 accent-primary"
        {...(onChange ? { checked, onChange: (event) => onChange(event.target.checked) } : { defaultChecked: checked })}
      />
      <span className="text-sm font-medium">
        {label}
        <span className="block font-normal text-muted-foreground">{description}</span>
      </span>
    </label>
  );
}

/**
 * The article editor's Settings: who can read it, where it's listed, and its address and what
 * search engines and docs search get. Saved apart from its title and text, and at once (none of it
 * waits for "Publish changes").
 */
export function ArticleSettings({
  projectSlug,
  article,
  groups,
  inherit,
}: {
  projectSlug: string;
  article: {
    slug: string;
    listing: Listing;
    access: Access;
    /** Its groups' keys (with access "groups"). */
    groups: string[];
    customSlug: boolean;
    description: string;
    keywords: string[];
    noindex: boolean;
  };
  /** The project's groups, for "Who can read". */
  groups: GroupOption[];
  /** "Who can read"'s first choice: what it inherits from, and what that lets read. */
  inherit: { label: string; description: string };
}) {
  const [open, setOpen] = useState(false);
  const [state, action, pending] = useActionState<FormState, FormData>(async (prev, formData) => {
    const result = await saveArticleSettings(projectSlug, article.slug, prev, formData);
    if (!result.error) {
      setOpen(false);
      toast.success("Settings saved");
    }
    return result;
  }, {});
  const [listing, setListing] = useState<Listing>(article.listing);
  const [customSlug, setCustomSlug] = useState(article.customSlug);

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        // Opened again: as saved, not as left.
        if (next) {
          setListing(article.listing);
          setCustomSlug(article.customSlug);
        }
        setOpen(next);
      }}
    >
      <DialogTrigger render={<Button variant="ghost" />}>Settings</DialogTrigger>
      <DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-lg">
        <form {...keepingFields(action)}>
          <DialogHeader>
            <DialogTitle>Article settings</DialogTitle>
          </DialogHeader>
          <FieldGroup className="my-4">
            <WhoCanRead
              id="article-access"
              projectSlug={projectSlug}
              groups={groups}
              inherit={inherit}
              defaultAccess={article.access}
              defaultGroups={article.groups}
            />
            <Field>
              <FieldLabel id="article-listing-label">Listed in</FieldLabel>
              <Select name="listing" items={LISTING_LABELS} value={listing} onValueChange={(value) => setListing(value as Listing)}>
                <SelectTrigger className="w-full" aria-labelledby="article-listing-label" aria-describedby="article-listing-description">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {LISTINGS.map((value) => (
                    <SelectItem key={value} value={value}>
                      {LISTING_LABELS[value]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <FieldDescription id="article-listing-description">{LISTING_DESCRIPTIONS[listing]}</FieldDescription>
            </Field>
            <FieldSet>
              <FieldLegend>Search</FieldLegend>
              <FieldGroup>
                <Field>
                  <Toggle
                    name="customSlug"
                    checked={customSlug}
                    onChange={setCustomSlug}
                    label="Custom slug"
                    description="Set the end of the URL instead of using the title."
                  />
                  {customSlug && (
                    <Input
                      name="newSlug"
                      aria-label="Slug"
                      defaultValue={article.slug}
                      placeholder="getting-started"
                      required
                      autoComplete="off"
                      pattern="[a-z0-9]+(-[a-z0-9]+)*"
                      title="Lowercase letters, digits and hyphens"
                      aria-invalid={state.error ? true : undefined}
                      aria-describedby={state.error ? "article-settings-error" : undefined}
                    />
                  )}
                </Field>
                <Field>
                  <FieldLabel htmlFor="article-description">Meta description</FieldLabel>
                  <Textarea
                    id="article-description"
                    name="description"
                    rows={2}
                    maxLength={300}
                    defaultValue={article.description}
                    placeholder="From the text when left empty"
                    aria-describedby="article-description-hint"
                  />
                  <FieldDescription id="article-description-hint">Shown under the title in search results.</FieldDescription>
                </Field>
                <Field>
                  <FieldLabel htmlFor="article-keywords">Keywords</FieldLabel>
                  <Textarea
                    id="article-keywords"
                    name="keywords"
                    rows={2}
                    defaultValue={article.keywords.join(", ")}
                    placeholder="Separate terms with commas"
                    aria-describedby="article-keywords-hint"
                  />
                  <FieldDescription id="article-keywords-hint">Terms a customer might search for when they need this article.</FieldDescription>
                </Field>
                <Toggle name="noindex" checked={article.noindex} label="Block search indexing" description="Asks search engines not to list this article." />
              </FieldGroup>
            </FieldSet>
            {state.error && <FieldError id="article-settings-error">{state.error}</FieldError>}
          </FieldGroup>
          <DialogFooter className="items-center sm:justify-between">
            <p className="text-sm text-muted-foreground">Applies to this article.</p>
            <Button type="submit" disabled={pending}>
              {pending ? "Saving…" : "Save changes"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
