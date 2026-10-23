"use client";

import { XIcon } from "lucide-react";
import { useActionState, useEffect, useRef, useState, useTransition } from "react";
import { toast } from "sonner";

import { EmptyState } from "@/components/empty-state";
import { ItemList, ItemRow } from "@/components/item-list";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { keepingFields } from "@/lib/forms";
import { type GroupCondition, MAX_CONDITIONS } from "@/lib/group-conditions";
import type { FormState } from "@/server/form-state";
import { deleteGroup, previewGroup, saveGroup } from "@/server/groups";
import type { GroupView } from "@/server/operations/groups";

const OPS = { is: "is", is_not: "is not", is_one_of: "is one of" } as const;
type Op = keyof typeof OPS;

const names = (list: string[]) => new Intl.ListFormat("en-GB").format(list);

/** "2 readers: Ada and Bea", "12 readers, including Ada, Bea and Cy". */
function whoIsIn({ readers, sample }: { readers: number; sample: string[] }) {
  const count = `${readers} ${readers === 1 ? "reader" : "readers"}`;
  return sample.length === 0 ? count : readers > sample.length ? `${count}, including ${names(sample)}` : `${count}: ${names(sample)}`;
}

/** The dialog's preview: "No readers match now.", "2 readers match now: Ada and Bea.", "12 readers match now, including …". */
function matchesNow({ readers, sample }: { readers: number; sample: string[] }) {
  if (readers === 0) {
    return "No readers match now.";
  }
  const count = readers === 1 ? "1 reader matches now" : `${readers} readers match now`;
  return readers > sample.length ? `${count}, including ${names(sample)}.` : `${count}: ${names(sample)}.`;
}

const conditionText =(c: GroupCondition) => `${c.attribute} ${OPS[c.op]} ${Array.isArray(c.value) ? c.value.join(", ") : c.value}`;

/** Settings → Groups: the project's reader groups, with who's in each now. */
export function ReaderGroups({ projectSlug, groups }: { projectSlug: string; groups: GroupView[] }) {
  return (
    <div className="flex flex-col gap-4">
      {groups.length === 0 ? (
        <EmptyState title="No groups yet" description="Add one, then pick it on a collection in Docs to make that collection for its readers only." />
      ) : (
        <ItemList>
          {groups.map((group) => (
            <ItemRow
              key={group.key}
              title={group.name}
              meta={
                <>
                  {group.claim && (
                    <>
                      <code className="break-all">{group.claim}</code>
                      {" · "}
                    </>
                  )}
                  {[group.conditions.map(conditionText).join(" and "), whoIsIn(group), group.description].filter(Boolean).join(" · ")}
                </>
              }
              actions={
                <>
                  <GroupDialog projectSlug={projectSlug} group={group} />
                  <DeleteGroupButton projectSlug={projectSlug} group={group} />
                </>
              }
            />
          ))}
        </ItemList>
      )}
      <div>
        <GroupDialog projectSlug={projectSlug} />
      </div>
    </div>
  );
}

/** A condition as typed: "is one of" takes its values comma-separated. */
type Row = { attribute: string; op: Op; value: string };

const rowsOf = (group?: GroupView): Row[] =>
  group?.conditions.map((c) => ({ attribute: c.attribute, op: c.op, value: Array.isArray(c.value) ? c.value.join(", ") : c.value })) ?? [];

const conditionOf = (row: Row) =>
  row.op === "is_one_of"
    ? { attribute: row.attribute, op: row.op, value: row.value.split(",").map((v) => v.trim()).filter(Boolean) }
    : { attribute: row.attribute, op: row.op, value: row.value };

const complete = (row: Row) => row.attribute.trim() !== "" && row.value.split(",").some((v) => v.trim() !== "");

const PREVIEW_DELAY_MS = 300;

/** Adds a group, or (with `group`) changes one. */
function GroupDialog({ projectSlug, group }: { projectSlug: string; group?: GroupView }) {
  const [open, setOpen] = useState(false);
  const [claim, setClaim] = useState(group?.claim ?? "");
  const [rows, setRows] = useState<Row[]>(() => rowsOf(group));
  const [preview, setPreview] = useState<{ readers: number; sample: string[] } | { error: string } | null>(null);
  const latest = useRef(0);
  const [state, action, pending] = useActionState<FormState, FormData>(async (prev, formData) => {
    const result = await saveGroup(projectSlug, group?.key ?? null, prev, formData);
    if (!result.error) {
      setOpen(false);
      toast.success(group ? "Group saved" : "Group added");
    }
    return result;
  }, {});
  const id = group?.key ?? "new";

  // Who'd be in it, once typing pauses; replies to older rules are ignored.
  // With conditions, once they're all complete; without, the claim's.
  const previewable = open && (rows.length > 0 ? rows.every(complete) : claim.trim() !== "");
  useEffect(() => {
    const query = ++latest.current;
    if (!previewable) {
      return;
    }
    const timer = setTimeout(async () => {
      const result = await previewGroup(projectSlug, claim.trim() || null, rows.map(conditionOf));
      if (query === latest.current) {
        setPreview(result);
      }
    }, PREVIEW_DELAY_MS);
    return () => clearTimeout(timer);
  }, [previewable, projectSlug, claim, rows]);

  const change = (i: number, patch: Partial<Row>) => setRows((current) => current.map((row, j) => (j === i ? { ...row, ...patch } : row)));

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        // Each time it opens: the group as saved (or empty, for a new one).
        if (next) {
          setClaim(group?.claim ?? "");
          setRows(rowsOf(group));
        }
        setOpen(next);
      }}
    >
      <DialogTrigger
        render={<Button variant={group ? "ghost" : "outline"} size="sm" aria-label={group ? `Edit ${group.name}` : undefined} />}
      >
        {group ? "Edit" : "New group"}
      </DialogTrigger>
      <DialogContent className="sm:max-w-xl">
        <form {...keepingFields(action)}>
          <DialogHeader>
            <DialogTitle>{group ? "Edit group" : "New group"}</DialogTitle>
          </DialogHeader>
          <FieldGroup className="my-4">
            <Field data-invalid={state.error ? true : undefined}>
              <FieldLabel htmlFor={`group-name-${id}`}>Name</FieldLabel>
              <Input
                id={`group-name-${id}`}
                name="name"
                defaultValue={group?.name}
                placeholder="Enterprise"
                maxLength={50}
                required
                aria-invalid={state.error ? true : undefined}
              />
              {state.error && <FieldError>{state.error}</FieldError>}
            </Field>
            <Field>
              <FieldLabel htmlFor={`group-claim-${id}`}>SSO group name (optional)</FieldLabel>
              <Input
                id={`group-claim-${id}`}
                name="claim"
                value={claim}
                onChange={(e) => setClaim(e.target.value)}
                placeholder="enterprise"
                maxLength={50}
                autoComplete="off"
              />
              <FieldDescription>
                Readers are in this group when your app signs them in with this in the token&apos;s <code>groups</code>, or when they
                match the conditions below.{group && " Changing either changes who's in it."}
              </FieldDescription>
            </Field>
            <fieldset className="flex flex-col gap-3">
              <legend className="mb-1 text-sm font-medium">Conditions</legend>
              <p className="text-sm text-muted-foreground">
                On the properties your app gives its users (in its sign-in token or the API), such as <code>plan</code> or <code>role</code>.
                Values match exactly, capital letters too.
              </p>
              {rows.length > 0 && <p className="text-xs font-medium text-muted-foreground">All must match</p>}
              {rows.map((row, i) => (
                <div key={i} role="group" aria-label={`Condition ${i + 1}`} className="flex flex-wrap items-center gap-2">
                  <Input
                    aria-label="Attribute"
                    value={row.attribute}
                    onChange={(e) => change(i, { attribute: e.target.value })}
                    placeholder="plan"
                    maxLength={64}
                    autoComplete="off"
                    className="min-w-0 flex-1 basis-28"
                  />
                  <Select items={OPS} value={row.op} onValueChange={(op) => change(i, { op: op as Op })}>
                    <SelectTrigger className="w-32" aria-label="Operator">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {(Object.keys(OPS) as Op[]).map((op) => (
                        <SelectItem key={op} value={op}>
                          {OPS[op]}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <Input
                    aria-label="Value"
                    value={row.value}
                    onChange={(e) => change(i, { value: e.target.value })}
                    placeholder={row.op === "is_one_of" ? "pro, enterprise" : "pro"}
                    autoComplete="off"
                    className="min-w-0 flex-1 basis-36"
                  />
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    aria-label="Remove condition"
                    onClick={() => setRows((current) => current.filter((_, j) => j !== i))}
                  >
                    <XIcon />
                  </Button>
                </div>
              ))}
              <div>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={rows.length >= MAX_CONDITIONS}
                  onClick={() => setRows((current) => [...current, { attribute: "", op: "is", value: "" }])}
                >
                  Add condition
                </Button>
              </div>
              <input type="hidden" name="conditions" value={JSON.stringify(rows.map(conditionOf))} />
              <div role="status" className="rounded-lg bg-muted px-3 py-2 text-sm break-words">
                {!previewable || preview === null ? (
                  <span className="text-muted-foreground">Complete a condition to see who matches.</span>
                ) : "error" in preview ? (
                  <span className="text-muted-foreground">{preview.error}</span>
                ) : (
                  matchesNow(preview)
                )}
              </div>
            </fieldset>
            <Field>
              <FieldLabel htmlFor={`group-description-${id}`}>Description</FieldLabel>
              <Textarea
                id={`group-description-${id}`}
                name="description"
                rows={2}
                maxLength={300}
                defaultValue={group?.description}
                placeholder="Optional, for your team"
              />
            </Field>
          </FieldGroup>
          <DialogFooter>
            <Button type="submit" disabled={pending}>
              {group ? "Save" : "Add group"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function DeleteGroupButton({ projectSlug, group }: { projectSlug: string; group: GroupView }) {
  const [pending, startTransition] = useTransition();
  return (
    <AlertDialog>
      <AlertDialogTrigger render={<Button variant="ghost" size="sm" disabled={pending} aria-label={`Delete ${group.name}`} />}>Delete</AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle className="break-words">Delete {group.name}?</AlertDialogTitle>
          <AlertDialogDescription>
            It can&apos;t be undone. A group a collection is for can&apos;t be deleted, since that would open the collection to everyone:
            remove it there first.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={pending}>Cancel</AlertDialogCancel>
          <AlertDialogAction
            variant="destructive"
            disabled={pending}
            onClick={() =>
              startTransition(async () => {
                const result = await deleteGroup(projectSlug, group.key);
                if (result.error) {
                  toast.error(result.error);
                } else {
                  toast.success(`${group.name} deleted`);
                }
              })
            }
          >
            Delete
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
