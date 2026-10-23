"use client";

import { UsersIcon, XIcon } from "lucide-react";
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
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Field, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { keepingFields } from "@/lib/forms";
import { type GroupCondition, LIST_OPERATORS, MAX_CONDITIONS, type Operator, OPERATORS, PRESENCE_OPERATORS } from "@/lib/group-conditions";
import type { FormState } from "@/server/form-state";
import { deleteGroup, type GroupPreview, previewGroup, saveGroup } from "@/server/groups";
import type { GroupView } from "@/server/operations/groups";


const names = (list: string[]) => new Intl.ListFormat("en-GB").format(list);

const usersCount = (count: number) => `${count} ${count === 1 ? "user" : "users"}`;

/** "2 users: Ada and Bea", "12 users, including Ada, Bea and Cy". */
function whoIsIn({ readers, sample }: { readers: number; sample: string[] }) {
  const count = usersCount(readers);
  return sample.length === 0 ? count : readers > sample.length ? `${count}, including ${names(sample)}` : `${count}: ${names(sample)}`;
}

const conditionText = (c: GroupCondition) =>
  [c.property, OPERATORS[c.op], "value" in c ? (Array.isArray(c.value) ? c.value.join(", ") : c.value) : ""].filter(Boolean).join(" ");

/** Settings → Groups: the project's reader groups, with who's in each now. `properties`: the names its users have, suggested in the dialog. */
export function ReaderGroups({ projectSlug, groups, properties }: { projectSlug: string; groups: GroupView[]; properties: string[] }) {
  return (
    <div className="flex flex-col gap-4">
      {groups.length === 0 ? (
        <EmptyState title="No groups yet" description="Add one, then pick it on a tab, collection or article in Docs to make it for its users only." />
      ) : (
        <ItemList>
          {groups.map((group) => (
            <ItemRow
              key={group.key}
              title={group.name}
              meta={[group.conditions.map(conditionText).join(" and "), whoIsIn(group), group.description].filter(Boolean).join(" · ")}
              actions={
                <>
                  <GroupDialog projectSlug={projectSlug} properties={properties} group={group} />
                  <DeleteGroupButton projectSlug={projectSlug} group={group} />
                </>
              }
            />
          ))}
        </ItemList>
      )}
      <div>
        <GroupDialog projectSlug={projectSlug} properties={properties} />
      </div>
    </div>
  );
}

/** A condition as typed: "is any of" and "is none of" take their values comma-separated; "is set" and "is not set" none. */
type Row = { property: string; op: Operator; value: string };

const takesNoValue = (op: Operator) => PRESENCE_OPERATORS.includes(op);

const EMPTY_ROW: Row = { property: "", op: "is", value: "" };

/** A group's conditions as rows; a new group starts with one to fill in (it needs at least one). */
const rowsOf = (group?: GroupView): Row[] =>
  group?.conditions.map((c) => ({ property: c.property, op: c.op, value: "value" in c ? (Array.isArray(c.value) ? c.value.join(", ") : c.value) : "" })) ?? [
    EMPTY_ROW,
  ];

const conditionOf = (row: Row) =>
  takesNoValue(row.op)
    ? { property: row.property, op: row.op }
    : LIST_OPERATORS.includes(row.op)
      ? { property: row.property, op: row.op, value: row.value.split(",").map((v) => v.trim()).filter(Boolean) }
      : { property: row.property, op: row.op, value: row.value };

const complete = (row: Row) => row.property.trim() !== "" && (takesNoValue(row.op) || row.value.split(",").some((v) => v.trim() !== ""));

const PREVIEW_DELAY_MS = 300;

/**
 * Adds a group, or (with `group`) changes one: its name, description and conditions on the left, and
 * the users who match them now on the right, as they're written.
 */
function GroupDialog({ projectSlug, properties, group }: { projectSlug: string; properties: string[]; group?: GroupView }) {
  const [open, setOpen] = useState(false);
  const [rows, setRows] = useState<Row[]>(() => rowsOf(group));
  const [preview, setPreview] = useState<GroupPreview | { error: string } | null>(null);
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

  // Who'd be in it, once typing pauses and every condition is complete; replies to older conditions are ignored.
  const previewable = open && rows.length > 0 && rows.every(complete);
  useEffect(() => {
    const query = ++latest.current;
    if (!previewable) {
      return;
    }
    const timer = setTimeout(async () => {
      const result = await previewGroup(projectSlug, rows.map(conditionOf));
      if (query === latest.current) {
        setPreview(result);
      }
    }, PREVIEW_DELAY_MS);
    return () => clearTimeout(timer);
  }, [previewable, projectSlug, rows]);

  const change = (i: number, patch: Partial<Row>) => setRows((current) => current.map((row, j) => (j === i ? { ...row, ...patch } : row)));
  const shown = previewable ? preview : null;

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        // Each time it opens: the group as saved (or one empty condition, for a new one).
        if (next) {
          setRows(rowsOf(group));
          setPreview(null);
        }
        setOpen(next);
      }}
    >
      <DialogTrigger
        render={<Button variant={group ? "ghost" : "outline"} size="sm" aria-label={group ? `Edit ${group.name}` : undefined} />}
      >
        {group ? "Edit" : "New group"}
      </DialogTrigger>
      <DialogContent className="max-h-[calc(100dvh-2rem)] gap-0 overflow-y-auto p-0 sm:max-w-4xl md:overflow-hidden">
        <div className="grid md:h-[min(42rem,calc(100dvh-2rem))] md:grid-cols-2">
          <form {...keepingFields(action)} className="flex min-h-0 flex-col">
            <div className="flex min-h-0 flex-1 flex-col gap-5 p-5 md:overflow-y-auto">
              <DialogHeader>
                <DialogTitle>{group ? "Edit group" : "New group"}</DialogTitle>
                <DialogDescription>
                  Users whose properties match these conditions are in this group, now and as they change.
                </DialogDescription>
              </DialogHeader>
              <FieldGroup>
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
                  <FieldLabel htmlFor={`group-description-${id}`}>Description (optional)</FieldLabel>
                  <Textarea
                    id={`group-description-${id}`}
                    name="description"
                    rows={2}
                    maxLength={300}
                    defaultValue={group?.description}
                    placeholder="Paying enterprise plan users"
                  />
                </Field>
                <div role="group" aria-labelledby={`group-conditions-${id}`} className="flex min-w-0 flex-col gap-3">
                  <div className="flex items-baseline justify-between gap-2">
                    <span id={`group-conditions-${id}`} className="text-sm font-medium">
                      Conditions
                    </span>
                    <span className="text-xs text-muted-foreground">All must match</span>
                  </div>
                  <datalist id={`group-properties-${id}`}>
                    {properties.map((name) => (
                      <option key={name} value={name} />
                    ))}
                  </datalist>
                  {rows.map((row, i) => (
                    <div key={i} className="flex flex-col gap-3">
                      {i > 0 && (
                        <div className="flex items-center gap-2 text-xs font-medium text-muted-foreground" aria-hidden>
                          AND
                          <span className="h-px flex-1 bg-border" />
                        </div>
                      )}
                      <div role="group" aria-label={`Condition ${i + 1}`} className="flex flex-col gap-2">
                        <div className="flex items-center gap-2">
                          <Input
                            aria-label="Property"
                            value={row.property}
                            onChange={(e) => change(i, { property: e.target.value })}
                            placeholder="plan"
                            maxLength={64}
                            autoComplete="off"
                            list={`group-properties-${id}`}
                            className="min-w-0 flex-1 font-mono"
                          />
                          <Select items={OPERATORS} value={row.op} onValueChange={(op) => change(i, { op: op as Operator })}>
                            <SelectTrigger className="w-32 shrink-0" aria-label="Operator">
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              {(Object.keys(OPERATORS) as Operator[]).map((op) => (
                                <SelectItem key={op} value={op}>
                                  {OPERATORS[op]}
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon-sm"
                            aria-label="Remove condition"
                            disabled={rows.length === 1}
                            onClick={() => setRows((current) => current.filter((_, j) => j !== i))}
                          >
                            <XIcon />
                          </Button>
                        </div>
                        {!takesNoValue(row.op) && (
                          <Input
                            aria-label="Value"
                            value={row.value}
                            onChange={(e) => change(i, { value: e.target.value })}
                            placeholder={LIST_OPERATORS.includes(row.op) ? "pro, enterprise" : "enterprise"}
                            autoComplete="off"
                            className="font-mono"
                          />
                        )}
                      </div>
                    </div>
                  ))}
                  <div>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      disabled={rows.length >= MAX_CONDITIONS}
                      onClick={() => setRows((current) => [...current, EMPTY_ROW])}
                    >
                      Add condition
                    </Button>
                  </div>
                  <p className="text-xs text-muted-foreground">
                    Values match exactly, capital letters too. Your app gives users their properties in its sign-in token or the API; the
                    token&apos;s <code>groups</code> is the <code>groups</code> property.
                  </p>
                  <input type="hidden" name="conditions" value={JSON.stringify(rows.map(conditionOf))} />
                </div>
              </FieldGroup>
            </div>
            <div className="border-t p-4">
              <Button type="submit" className="w-full" disabled={pending}>
                {group ? "Save" : "Add group"}
              </Button>
            </div>
          </form>
          <MatchingUsers preview={shown} />
        </div>
      </DialogContent>
    </Dialog>
  );
}

/** The dialog's right side: the users who match the conditions now, or why there's nothing to show. */
function MatchingUsers({ preview }: { preview: GroupPreview | { error: string } | null }) {
  const users = preview && "users" in preview ? preview.users : [];
  const status =
    preview === null
      ? "Complete a condition to see who matches."
      : "error" in preview
        ? preview.error
        : preview.readers === 0
          ? "No matching users"
          : `${preview.readers} matching ${preview.readers === 1 ? "user" : "users"}`;
  return (
    <section aria-label="Who matches" className="flex min-h-48 flex-col border-t bg-muted/40 md:min-h-0 md:border-t-0 md:border-l">
      <div role="status" className="flex items-center gap-2 border-b px-5 py-3.5 pr-12 text-sm font-medium">
        <UsersIcon className="size-4 text-muted-foreground" aria-hidden />
        {status}
      </div>
      {users.length > 0 ? (
        <ul aria-label="Matching users" className="flex min-h-0 flex-1 flex-col divide-y overflow-y-auto px-5">
          {users.map((user) => (
            <li key={user.id} className="flex items-center gap-3 py-2.5">
              <Avatar className="size-7">
                {user.avatar && <AvatarImage src={user.avatar} alt="" />}
                <AvatarFallback>{user.name.slice(0, 1).toUpperCase()}</AvatarFallback>
              </Avatar>
              <div className="flex min-w-0 flex-col">
                <span className="text-sm break-words">{user.name}</span>
                <span className="text-xs break-all text-muted-foreground">{user.email ?? `id ${user.id}`}</span>
              </div>
            </li>
          ))}
          {preview && "readers" in preview && preview.readers > users.length && (
            <li className="py-2.5 text-xs text-muted-foreground">and {preview.readers - users.length} more</li>
          )}
        </ul>
      ) : (
        <div className="flex flex-1 flex-col items-center justify-center gap-3 p-8 text-center text-sm text-muted-foreground">
          <span className="flex size-10 items-center justify-center rounded-lg border bg-background">
            <UsersIcon className="size-5" aria-hidden />
          </span>
          {preview && "readers" in preview ? "No users match these conditions yet." : "The users who match will show here."}
        </div>
      )}
    </section>
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
