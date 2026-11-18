"use client";

import Link from "next/link";
import { unstable_rethrow } from "next/navigation";
import { type DragEvent, type FormEvent, useEffect, useRef, useState, useTransition } from "react";
import { createPortal } from "react-dom";
import { toast } from "sonner";

import { ApiReferenceSync } from "@/components/api-reference-endpoints";
import { MoveMenu } from "@/components/docs-tree";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { useEditorSlot } from "@/components/use-editor-slot";
import { type ApiReferenceSettings as Changes, changeApiReferenceUrl, saveApiReferenceSettings } from "@/server/api-references";

/**
 * An API reference's Settings (docs/plan.md, A9). Its name, address and base address share one Save, in the
 * header; the tree's style, the groups' order and Try it save as they change, as switches and selects do.
 */

type TreeStyle = "folders" | "headings" | "entry";

const TREE_STYLES: [TreeStyle, string, string][] = [
  ["folders", "Groups as folders", "Each group is a folder that opens to its endpoints."],
  ["headings", "Groups as headings", "Each group is a heading with its endpoints under it. Nothing folds."],
  ["entry", "One entry", "The reference is one row in the tree that opens to its groups."],
];

const SAVE_FAILED = { error: "Couldn't save that. Try again." };

/**
 * A URL source's address, changed here: the new one is read before it's kept (as adding one reads it), so one that
 * doesn't work is said under the field and the reference stays as it was. The toast says what the new spec changed.
 */
function SourceUrl({ projectSlug, slug, url }: { projectSlug: string; slug: string; url: string }) {
  // Only what's typed over what's stored: a field left alone shows the address the page has now (a teammate's change
  // included), so Change can't put an old one back.
  const [edited, setEdited] = useState<string | null>(null);
  const value = edited ?? url;
  const [error, setError] = useState<string>();
  const [pending, startTransition] = useTransition();
  const next = value.trim();
  const change = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!next || next === url || pending) {
      return;
    }
    setError(undefined);
    startTransition(async () => {
      const result = await changeApiReferenceUrl(projectSlug, slug, next).catch(() => SAVE_FAILED as Awaited<ReturnType<typeof changeApiReferenceUrl>>);
      if (result.error) {
        setError(result.error);
        document.getElementById("reference-source-url")?.focus();
        return;
      }
      // Back to following the stored address, unless something else was typed while this one was read: that stays.
      setEdited((now) => (now !== null && now.trim() === next ? null : now));
      const what = [result.added && `${result.added} added`, result.removed && `${result.removed} removed`].filter(Boolean).join(", ");
      toast.success(what ? `Address changed: ${what}` : "Address changed");
    });
  };
  return (
    <form onSubmit={change}>
      <Field data-invalid={error ? true : undefined}>
        <FieldLabel htmlFor="reference-source-url">Spec URL</FieldLabel>
        <div className="flex gap-2">
          <Input
            id="reference-source-url"
            type="url"
            inputMode="url"
            value={value}
            maxLength={2000}
            aria-invalid={error ? true : undefined}
            aria-describedby="reference-source-url-note"
            onChange={(event) => {
              // The stored address typed back is the field left alone: it follows the stored one again.
              setEdited(event.target.value.trim() === url ? null : event.target.value);
              setError(undefined);
            }}
          />
          <Button type="submit" variant="outline" disabled={pending || !next || next === url} focusableWhenDisabled>
            {pending ? "Changing…" : "Change"}
          </Button>
        </div>
        {error ? (
          <FieldError id="reference-source-url-note">{error}</FieldError>
        ) : (
          <FieldDescription id="reference-source-url-note">A new address is read before it’s kept, and fetched every 6 hours from then on.</FieldDescription>
        )}
      </Field>
    </form>
  );
}

/**
 * A value picked in a control that saves at once, over the page's own (`saved`): shown from the click until the page
 * has it. Not just until the save answers: the refreshed page comes after its answer, and in between the old value
 * would show again, and the next pick (a group moved again) would start from it. `saving` while the save is on its way.
 */
function usePicked<T>(saved: T) {
  const [picked, setPicked] = useState<{ value: T; saving: boolean } | null>(null);
  // The page's value as text, to see it change: then it has the save, or a teammate's (unless one of ours is on its way).
  const now = JSON.stringify(saved);
  const [seen, setSeen] = useState(now);
  if (seen !== now) {
    setSeen(now);
    if (picked && !picked.saving) setPicked(null);
  }
  return {
    value: picked ? picked.value : saved,
    saving: picked?.saving ?? false,
    pick: (value: T) => setPicked({ value, saving: true }),
    /** Saved: kept until the page has it. Refused: back as the page has it. */
    settle: (ok: boolean) => setPicked((current) => (ok && current ? { ...current, saving: false } : null)),
  };
}

export function ApiReferenceSettings({
  projectSlug,
  host,
  reference,
  source,
  groups,
  warnings,
  maxBytes,
}: {
  projectSlug: string;
  /** The help center's host, before the reference's address: "acme.tuti.so". */
  host: string;
  reference: { slug: string; name: string; baseUrl: string | null; treeStyle: TreeStyle; tryIt: boolean };
  /** Where the spec is read from, as rows of words ("From", "Uploaded file"), and its kind ("upload"); a URL's address. */
  source: { kind: string; rows: [string, string][]; url?: string | null };
  /** In the team's order, with how many endpoints are listed under each. */
  groups: { key: string; name: string; endpoints: number }[];
  /** What the reader couldn't read, by kind: the first places of each. */
  warnings: { code: string; message: string; count: number; where: string[] }[];
  maxBytes: number;
}) {
  // A new address's redirect comes back as a rejection for the router to follow, not a failure.
  const save = (changes: Changes) =>
    saveApiReferenceSettings(projectSlug, reference.slug, changes).catch((error: unknown) => {
      unstable_rethrow(error);
      return SAVE_FAILED;
    });

  // What's typed in each field, over what's saved: one left alone shows what the page has now (a teammate's change
  // too, once another save refreshes it), and Save sends only the ones typed in that differ, never one left alone.
  const saved = { name: reference.name, slug: reference.slug, baseUrl: reference.baseUrl ?? "" };
  const [edits, setEdits] = useState<Partial<typeof saved>>({});
  const draft = { ...saved, ...edits };
  const edit = (field: keyof typeof saved, value: string) => setEdits((now) => ({ ...now, [field]: value }));
  const changed = (Object.keys(edits) as (keyof typeof saved)[]).filter((field) => draft[field].trim() !== saved[field]);
  const [saving, startSaving] = useTransition();
  const submit = (event: FormEvent) => {
    event.preventDefault();
    const changes: Changes = {
      ...(changed.includes("name") && { name: draft.name }),
      ...(changed.includes("slug") && { newSlug: draft.slug }),
      ...(changed.includes("baseUrl") && { baseUrl: draft.baseUrl.trim() || null }),
    };
    const sent = { ...edits };
    startSaving(async () => {
      const result = await save(changes).catch((redirect: unknown) => {
        // Saved at a new address: the router goes to its Settings.
        toast.success("Settings saved");
        throw redirect;
      });
      if (result.error) {
        toast.error(result.error);
        return;
      }
      toast.success("Settings saved");
      // Saved: the page has them now. One typed in again while it saved stays.
      setEdits((now) => Object.fromEntries(Object.entries(now).filter(([field, value]) => sent[field as keyof typeof saved] !== value)));
    });
  };
  const actionsHost = useEditorSlot("api-reference-actions");

  // The controls that save at once: what was picked shows until the page has it, or, refused, it's back as it was.
  const tree = usePicked(reference.treeStyle);
  const tryIt = usePicked(reference.tryIt);
  const order = usePicked(groups.map((group) => group.key));
  const [, startChange] = useTransition();
  const change = <T,>(picked: ReturnType<typeof usePicked<T>>, value: T, changes: Changes, done: string) => {
    picked.pick(value);
    startChange(async () => {
      const result = await save(changes);
      if (result.error) toast.error(result.error);
      else toast.success(done);
      picked.settle(!result.error);
    });
  };

  const keys = order.value;
  const byKey = new Map(groups.map((group) => [group.key, group]));
  const listed = keys.map((key) => byKey.get(key)).filter((group) => group !== undefined);
  const handle = (key: string) => `group-move-${encodeURIComponent(key)}`;
  // The handle to focus again once a move has saved: it's disabled meanwhile (some browsers then drop its focus).
  const refocus = useRef<string | null>(null);
  /** Group `key` to place `to`; from its handle's menu (`byMenu`), its handle is focused again once saved. */
  const move = (key: string, to: number, byMenu = false) => {
    const next = keys.filter((other) => other !== key);
    next.splice(to, 0, key);
    refocus.current = byMenu ? handle(key) : null;
    change(order, next, { groupOrder: next }, "Group order saved");
  };
  useEffect(() => {
    if (!order.saving && refocus.current) {
      document.getElementById(refocus.current)?.focus();
      refocus.current = null;
    }
  }, [order.saving]);
  const [dragging, setDragging] = useState<string | null>(null);
  const rowOf = (event: DragEvent) => (event.target as Element).closest<HTMLElement>("[data-group-key]")?.dataset.groupKey;

  const field = "[&_[data-slot=field-description]]:text-xs";
  return (
    <div className="grid items-start gap-4 @min-[52rem]/docs-page:grid-cols-2">
      <div className="flex min-w-0 flex-col gap-4">
        <form id="api-reference-settings" onSubmit={submit} className="contents">
          <Card role="region" aria-labelledby="reference-name-title">
            <CardHeader>
              <CardTitle id="reference-name-title" className="text-base">Name and address</CardTitle>
            </CardHeader>
            <CardContent>
              <FieldGroup className={field}>
                <Field>
                  <FieldLabel htmlFor="reference-name">Name</FieldLabel>
                  <Input id="reference-name" value={draft.name} required maxLength={80} autoComplete="off" onChange={(event) => edit("name", event.target.value)} />
                </Field>
                <Field>
                  <FieldLabel htmlFor="reference-slug">Address</FieldLabel>
                  <div className="flex min-w-0 items-center gap-1.5">
                    {/* A narrow pane keeps the part that's the docs' own. */}
                    <span className="min-w-0 truncate text-sm text-muted-foreground">
                      <span className="@max-[36rem]/docs-page:hidden">{host}</span>/docs/
                    </span>
                    <Input
                      id="reference-slug"
                      value={draft.slug}
                      required
                      maxLength={80}
                      autoComplete="off"
                      pattern="[a-z0-9]+(-[a-z0-9]+)*"
                      title="Lowercase letters, digits and hyphens"
                      aria-describedby="reference-slug-description"
                      className="min-w-32 flex-1 font-mono"
                      onChange={(event) => edit("slug", event.target.value)}
                    />
                  </div>
                  <FieldDescription id="reference-slug-description">Its pages move to the new address. Links to the old one stop working.</FieldDescription>
                </Field>
              </FieldGroup>
            </CardContent>
          </Card>
          <Card role="region" aria-labelledby="reference-base-title">
            <CardHeader>
              <CardTitle id="reference-base-title" className="text-base">Base address</CardTitle>
            </CardHeader>
            <CardContent>
              <Field className={field}>
                <FieldLabel htmlFor="reference-base-url" className="sr-only">Base address</FieldLabel>
                <Input
                  id="reference-base-url"
                  type="url"
                  value={draft.baseUrl}
                  placeholder="https://api.example.com"
                  // Checked once changed: an address saved before https was required doesn't hold up the other fields.
                  pattern={changed.includes("baseUrl") ? "https://.+" : undefined}
                  title="An address that starts with https://"
                  maxLength={2000}
                  autoComplete="off"
                  aria-describedby="reference-base-url-description"
                  onChange={(event) => edit("baseUrl", event.target.value)}
                />
                <FieldDescription id="reference-base-url-description">Requests in the examples and in Try it go here when the spec’s servers have no host.</FieldDescription>
              </Field>
            </CardContent>
          </Card>
        </form>
        <Card role="region" aria-labelledby="reference-source-title">
          <CardHeader>
            <CardTitle id="reference-source-title" className="text-base">Source</CardTitle>
            <CardDescription>Where this reference is read from.</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            {/* A row each, so a URL's or a repository's details are more rows. */}
            <dl className="grid grid-cols-[8rem_minmax(0,1fr)] gap-x-4 gap-y-2 text-sm max-sm:grid-cols-1 max-sm:gap-y-0.5 max-sm:[&_dd]:mb-2">
              {source.rows.map(([term, value]) => (
                <div key={term} className="contents">
                  <dt className="text-muted-foreground">{term}</dt>
                  <dd className="break-words">{value}</dd>
                </div>
              ))}
            </dl>
            {source.kind === "url" && <SourceUrl projectSlug={projectSlug} slug={reference.slug} url={source.url ?? ""} />}
            <div className="flex justify-end">
              <ApiReferenceSync projectSlug={projectSlug} slug={reference.slug} source={source.kind} maxBytes={maxBytes} inHeader={false} />
            </div>
          </CardContent>
        </Card>
        {warnings.length > 0 && (
          <Card role="region" aria-labelledby="reference-warnings-title">
            <CardHeader>
              <CardTitle id="reference-warnings-title" className="text-base">What couldn’t be read</CardTitle>
              <CardDescription>Its pages show without these parts of the spec, or with them guessed.</CardDescription>
            </CardHeader>
            <CardContent>
              <ul className="flex flex-col divide-y">
                {warnings.map((warning) => (
                  <li key={warning.code} className="flex gap-3 py-3 first:pt-0 last:pb-0">
                    <Badge variant="highlight" className="tabular-nums">
                      {warning.count.toLocaleString("en")}
                      <span className="sr-only">{warning.count === 1 ? " place:" : " places:"}</span>
                    </Badge>
                    <div className="min-w-0 flex-1">
                      <p className="break-words">{warning.message}</p>
                      <details className="group mt-1 text-xs text-muted-foreground">
                        <summary className="w-fit cursor-pointer font-medium text-foreground/80 hover:underline">Show where</summary>
                        <ul className="mt-1.5 flex flex-col gap-1 font-mono break-all">
                          {warning.where.map((where, at) => (
                            <li key={at}>{where}</li>
                          ))}
                        </ul>
                        {warning.count > warning.where.length && <p className="mt-1">and {(warning.count - warning.where.length).toLocaleString("en")} more</p>}
                      </details>
                    </div>
                  </li>
                ))}
              </ul>
            </CardContent>
          </Card>
        )}
      </div>
      <div className="flex min-w-0 flex-col gap-4">
        <Card role="region" aria-labelledby="reference-tree-title">
          <CardHeader>
            <CardTitle id="reference-tree-title" className="text-base">In the help center’s tree</CardTitle>
            <CardDescription>How the reference sits beside the tab’s articles.</CardDescription>
          </CardHeader>
          <CardContent>
            <fieldset className="flex flex-col gap-2">
              <legend className="sr-only">In the help center’s tree</legend>
              {TREE_STYLES.map(([value, label, description]) => (
                <label key={value} className="flex cursor-pointer items-start gap-3 rounded-lg border p-3 has-checked:border-primary has-checked:bg-accent/40 has-focus-visible:ring-3 has-focus-visible:ring-ring/50">
                  <input
                    type="radio"
                    name="treeStyle"
                    value={value}
                    checked={tree.value === value}
                    className="mt-0.5 size-4 accent-primary"
                    onChange={() => change(tree, value, { treeStyle: value }, `${label} saved`)}
                  />
                  <span className="flex flex-col gap-0.5">
                    <span className="font-medium">{label}</span>
                    <span className="text-xs text-muted-foreground">{description}</span>
                  </span>
                </label>
              ))}
            </fieldset>
          </CardContent>
        </Card>
        {listed.length > 1 && (
          <Card role="region" aria-labelledby="reference-groups-title">
            <CardHeader>
              <CardTitle id="reference-groups-title" className="text-base">Group order</CardTitle>
              <CardDescription>Drag to reorder, or use a group’s handle. Readers see this order; new groups go last.</CardDescription>
            </CardHeader>
            <CardContent>
              <ol
                aria-busy={order.saving}
                className="flex flex-col divide-y"
                onDragStart={(event) => {
                  const key = rowOf(event);
                  if (order.saving || !key) {
                    event.preventDefault();
                    return;
                  }
                  setDragging(key);
                  event.dataTransfer.effectAllowed = "move";
                  event.dataTransfer.setData("text/plain", key);
                }}
                onDragOver={(event) => {
                  if (dragging && rowOf(event)) {
                    event.preventDefault();
                    event.dataTransfer.dropEffect = "move";
                  }
                }}
                onDragEnd={() => setDragging(null)}
                onDrop={(event) => {
                  event.preventDefault();
                  const over = rowOf(event);
                  setDragging(null);
                  if (dragging && over && over !== dragging) move(dragging, keys.indexOf(over));
                }}
              >
                {listed.map((group, at) => (
                  <li key={group.key} draggable={!order.saving} data-group-key={group.key} className="flex cursor-grab items-center gap-2 py-1.5 data-[dragging]:opacity-50" data-dragging={dragging === group.key || undefined}>
                    <MoveMenu
                      id={handle(group.key)}
                      name={group.name}
                      disabled={order.saving}
                      up={at > 0 ? () => move(group.key, at - 1, true) : undefined}
                      down={at < listed.length - 1 ? () => move(group.key, at + 1, true) : undefined}
                    />
                    <span className="min-w-0 flex-1 break-words">{group.name}</span>
                    <span className="text-xs text-muted-foreground tabular-nums">
                      {group.endpoints}
                      <span className="sr-only">{group.endpoints === 1 ? " endpoint" : " endpoints"}</span>
                    </span>
                  </li>
                ))}
              </ol>
            </CardContent>
          </Card>
        )}
        <Card role="region" aria-labelledby="reference-try-it-title">
          <CardHeader>
            <CardTitle id="reference-try-it-title" className="text-base">Try it</CardTitle>
          </CardHeader>
          <CardContent>
            <label className="flex cursor-pointer items-start justify-between gap-4">
              <span className="flex flex-col gap-0.5">
                <span className="font-medium">Let readers try requests</span>
                <span className="text-xs text-muted-foreground">Each endpoint’s page can send a real request, with the reader’s own key kept in their browser.</span>
              </span>
              <Switch
                checked={tryIt.value}
                onChange={(event) => {
                  const on = event.currentTarget.checked;
                  change(tryIt, on, { tryIt: on }, on ? "Try it switched on" : "Try it switched off");
                }}
              />
            </label>
          </CardContent>
        </Card>
      </div>
      {actionsHost &&
        createPortal(
          <>
            {changed.length > 0 && (
              <span className="mr-auto inline-flex items-center gap-1.5 text-xs text-highlight-foreground">
                <span aria-hidden className="size-1 rounded-full bg-status-under-review" />
                {changed.length} unsaved {changed.length === 1 ? "change" : "changes"}
              </span>
            )}
            <Link href={`/app/${projectSlug}/docs/references/${reference.slug}`} className="p-[6px_8px] text-[13px] text-muted-foreground">
              Cancel
            </Link>
            <Button type="submit" form="api-reference-settings" disabled={saving} focusableWhenDisabled>
              {saving ? "Saving…" : "Save"}
            </Button>
          </>,
          actionsHost,
        )}
    </div>
  );
}
