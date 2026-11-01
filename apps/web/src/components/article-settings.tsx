"use client";

import { useActionState, useState } from "react";
import { toast } from "sonner";

import { type ArticlePlace, PlaceFields, useArticleEditor } from "@/components/docs";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetFooter, SheetHeader, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel, FieldLegend, FieldSeparator, FieldSet } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { type GroupOption, WhoCanRead } from "@/components/who-can-read";
import { type Listing, LISTING_DESCRIPTIONS, LISTING_LABELS, LISTINGS } from "@/lib/article-listing";
import { keepingFields } from "@/lib/forms";
import type { Access, WithoutAccess } from "@/lib/read-access";
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
  /** None when it isn't the form's (it's sent by another). */
  name?: string;
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

/** The article's collection and "Show the updated date", as fields of the form they're in (PlaceFields; `loaded`: only what's changed from it). */
function Place({
  place,
  loaded,
  onChange,
  published,
}: {
  place: ArticlePlace;
  loaded?: ArticlePlace;
  onChange: (place: ArticlePlace) => void;
  published?: boolean;
}) {
  const { collections } = useArticleEditor();
  const items = [{ value: null, label: "No collection" }, ...collections.map((c) => ({ value: c.slug, label: c.name }))];
  return (
    <FieldGroup>
      <PlaceFields place={place} loaded={loaded} />
      <Field>
        <FieldLabel id="article-collection-label">Collection</FieldLabel>
        <Select items={items} value={place.collection} onValueChange={(value) => onChange({ ...place, collection: value as string | null })}>
          <SelectTrigger
            className="w-full"
            aria-labelledby="article-collection-label"
            aria-describedby={published ? "article-collection-description" : undefined}
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {items.map((item) => (
              <SelectItem key={item.value ?? ""} value={item.value}>
                {item.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {published && <FieldDescription id="article-collection-description">A new collection goes live when you publish the changes.</FieldDescription>}
      </Field>
      <Toggle
        checked={place.showUpdatedDate}
        onChange={(showUpdatedDate) => onChange({ ...place, showUpdatedDate })}
        label="Show the updated date"
        description="Readers see when you last changed it after it was published."
      />
    </FieldGroup>
  );
}

/** A new article's place: its form's "Save draft" sends it (ArticleForm), as nothing's saved yet. */
function NewPlace() {
  const { place, setPlace } = useArticleEditor();
  return <Place place={place} onChange={setPlace} />;
}

/**
 * The article editor's Settings, a panel from the top bar: its collection and "Show the updated
 * date", then, once it's saved, who can read it, where it's listed, and its address and what search
 * engines and docs search get. A saved article's are saved by the panel's "Save changes", apart from
 * its title and text: on a published one a new collection waits for "Publish changes" (as the
 * article's Save would keep it), the rest changes at once. A new article's go with its first save.
 */
export function ArticleSettings({ saved }: { saved?: Saved }) {
  const [open, setOpen] = useState(false);
  return (
    // A panel from the right, beside the article (which stays as it was underneath).
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetTrigger render={<Button variant="ghost" />}>Settings</SheetTrigger>
      <SheetContent className="gap-0 data-[side=right]:w-full data-[side=right]:sm:max-w-md">
        {saved ? (
          <SavedSettings {...saved} onSaved={() => setOpen(false)} />
        ) : (
          <>
            <SheetHeader className="border-b">
              <SheetTitle>Article settings</SheetTitle>
            </SheetHeader>
            <div className="min-h-0 flex-1 overflow-y-auto p-4">
              <NewPlace />
            </div>
          </>
        )}
      </SheetContent>
    </Sheet>
  );
}

/** A saved article's settings that save in its panel. */
type Saved = {
  projectSlug: string;
  article: {
    slug: string;
    published: boolean;
    /** Its collection as saved last (its unpublished changes', if it has some). */
    collection: string | null;
    showUpdatedDate: boolean;
    listing: Listing;
    access: Access;
    /** Its groups' keys (with access "groups"). */
    groups: string[];
    /** "People without access". */
    noAccess: WithoutAccess;
    customSlug: boolean;
    description: string;
    keywords: string[];
    noindex: boolean;
  };
  /** The project's groups, for "Who can read". */
  groups: GroupOption[];
  /** "Who can read"'s first choice: what it inherits from, what that lets read, and what it shows the rest. */
  inherit: { label: string; description: string; shows: "lock" | "hide" };
  /** Its page on the portal, for "Preview as a reader" (published only). */
  preview?: string;
};

/** A saved article's panel (opened again: as saved, not as left). */
function SavedSettings({ projectSlug, article, groups, inherit, preview, onSaved }: Saved & { onSaved: () => void }) {
  const [state, action, pending] = useActionState<FormState, FormData>(async (prev, formData) => {
    const result = await saveArticleSettings(projectSlug, article.slug, prev, formData);
    if (!result.error) {
      onSaved();
      toast.success("Settings saved");
    }
    return result;
  }, {});
  const [listing, setListing] = useState<Listing>(article.listing);
  const [customSlug, setCustomSlug] = useState(article.customSlug);
  // As the panel opened: it sends only what's changed since, so someone else's newer move stays.
  const [loaded] = useState<ArticlePlace>({ collection: article.collection, showUpdatedDate: article.showUpdatedDate });
  const [place, setPlace] = useState(loaded);

  return (
    <form {...keepingFields(action)} className="flex min-h-0 flex-1 flex-col">
      <SheetHeader className="border-b">
        <SheetTitle>Article settings</SheetTitle>
      </SheetHeader>
      <FieldGroup className="min-h-0 flex-1 overflow-y-auto p-4">
        <Place place={place} loaded={loaded} onChange={setPlace} published={article.published} />
        <FieldSeparator />
        <WhoCanRead
          id="article-access"
          projectSlug={projectSlug}
          groups={groups}
          inherit={inherit}
          defaultAccess={article.access}
          defaultGroups={article.groups}
          defaultNoAccess={article.noAccess}
          preview={preview}
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
      <SheetFooter className="flex-row items-center justify-between border-t">
        <p className="text-sm text-muted-foreground">Applies to this article.</p>
        <Button type="submit" disabled={pending}>
          {pending ? "Saving…" : "Save changes"}
        </Button>
      </SheetFooter>
    </form>
  );
}
