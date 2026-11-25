"use client";

import { MoreHorizontalIcon, PlusIcon, UsersIcon, XIcon } from "lucide-react";
import { type ReactNode, useActionState, useEffect, useRef, useState, useTransition } from "react";
import { toast } from "sonner";

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Field, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { keepingFields } from "@/lib/forms";
import { count } from "@/lib/usage-format";
import { LIST_OPERATORS, type Match, MATCHES, MAX_CONDITIONS, type Operator, OPERATORS, PRESENCE_OPERATORS, ruleSummary } from "@tuti/shared/group-conditions";
import type { FormState } from "@/server/form-state";
import { deleteGroup, type GroupPreview, previewGroup, saveGroup, suggestValues } from "@/server/groups";
import type { GroupView } from "@/server/operations/groups";

const usersCount = (n: number) => `${count(n)} ${n === 1 ? "user" : "users"}`;

/**
 * Settings → Groups: the project's reader groups, each with how many users are in it now and its rule (who they are is
 * in Edit); Edit and Delete under the row's ⋯. `properties`: the names its users have, suggested in the dialog.
 */
export function ReaderGroups({ projectSlug, groups, properties }: { projectSlug: string; groups: GroupView[]; properties: string[] }) {
  if (groups.length === 0) {
    return <p className="px-4 py-3.5 text-sm text-muted-foreground @min-[34rem]/settings:px-5">No groups yet</p>;
  }
  return (
    <ul className="flex flex-col divide-y">
      {groups.map((group) => {
        const rule = ruleSummary(group);
        return (
          <li key={group.key} className="flex items-center gap-3 px-4 py-3.5 @min-[34rem]/settings:px-5">
            {/* Under 34rem of card (phones) the rule goes under the name, on lines of its own. */}
            <div className="flex min-w-0 flex-1 flex-col gap-x-5 gap-y-1.5 @min-[34rem]/settings:flex-row @min-[34rem]/settings:items-center">
              <div className="flex min-w-0 flex-1 flex-col">
                <span className="font-medium break-words">{group.name}</span>
                <span className="text-sm break-words text-muted-foreground">{[usersCount(group.readers), group.description].filter(Boolean).join(" · ")}</span>
              </div>
              {rule && (
                <Badge
                  variant="secondary"
                  title={rule}
                  className="h-auto min-h-5 max-w-full shrink justify-start self-start py-0.5 break-words whitespace-normal @min-[34rem]/settings:max-w-[50%] @min-[34rem]/settings:self-center"
                >
                  <span className="line-clamp-2">{rule}</span>
                </Badge>
              )}
            </div>
            <GroupActions projectSlug={projectSlug} properties={properties} group={group} />
          </li>
        );
      })}
    </ul>
  );
}

/** The list's "New group", at its card's title. */
export function NewGroupButton({ projectSlug, properties }: { projectSlug: string; properties: string[] }) {
  return (
    <GroupDialog
      projectSlug={projectSlug}
      properties={properties}
      trigger={(show) => (
        <Button variant="outline" size="sm" onClick={show}>
          <PlusIcon />
          New group
        </Button>
      )}
    />
  );
}

/** A group's ⋯ menu: Edit (its dialog) and Delete, which asks first. */
function GroupActions({ projectSlug, properties, group }: { projectSlug: string; properties: string[]; group: GroupView }) {
  const [pending, startTransition] = useTransition();
  const [deleting, setDeleting] = useState(false);
  return (
    <>
      <GroupDialog
        projectSlug={projectSlug}
        properties={properties}
        group={group}
        trigger={(show) => (
          <DropdownMenu>
            <DropdownMenuTrigger render={<Button variant="ghost" size="icon-sm" disabled={pending} focusableWhenDisabled aria-label={`Actions for ${group.name}`} />}>
              <MoreHorizontalIcon />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-auto min-w-32">
              <DropdownMenuItem onClick={show}>Edit</DropdownMenuItem>
              <DropdownMenuItem variant="destructive" onClick={() => setDeleting(true)}>
                Delete
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      />
      <AlertDialog open={deleting} onOpenChange={setDeleting}>
        <AlertDialogContent closeDisabled={pending}>
          <AlertDialogHeader>
            <AlertDialogTitle className="break-words">Delete {group.name}?</AlertDialogTitle>
            <AlertDialogDescription>
              It can&apos;t be undone. A group a tab, collection or article is for can&apos;t be deleted, since that would change who can
              read them: remove it from them first.
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
    </>
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

/** Operators whose one value the dialog suggests (a list's comma-separated values it doesn't). */
const suggestsValues = (op: Operator) => !takesNoValue(op) && !LIST_OPERATORS.includes(op);

const complete = (row: Row) => row.property.trim() !== "" && (takesNoValue(row.op) || row.value.split(",").some((v) => v.trim() !== ""));

const PREVIEW_DELAY_MS = 300;

type GroupDialogProps = { projectSlug: string; properties: string[]; group?: GroupView };

/**
 * The dialog that adds a group, or (with `group`) changes one, opened by what `trigger` renders. Each time it opens
 * it's a new one: the group as saved (or one empty condition, for a new one), and no error from the last try.
 */
function GroupDialog({ trigger, ...props }: GroupDialogProps & { trigger: (show: () => void) => ReactNode }) {
  const [open, setOpen] = useState(false);
  const [opened, setOpened] = useState(0);
  return (
    <>
      {trigger(() => {
        setOpened((n) => n + 1);
        setOpen(true);
      })}
      <GroupForm key={opened} open={open} setOpen={setOpen} {...props} />
    </>
  );
}

/**
 * A group's name, description and conditions on the left, and the users who match them now on the right, as
 * they're written.
 */
function GroupForm({ projectSlug, properties, group, open, setOpen }: GroupDialogProps & { open: boolean; setOpen: (open: boolean) => void }) {
  const [rows, setRows] = useState<Row[]>(() => rowsOf(group));
  const [match, setMatch] = useState<Match>(group?.match ?? "all");
  const [preview, setPreview] = useState<GroupPreview | { error: string } | null>(null);
  // Each property's values, as its users have them, once its name is typed (names fetched once each). A Map: any name, "constructor" too.
  const [values, setValues] = useState(() => new Map<string, string[]>());
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
      const result = await previewGroup(projectSlug, rows.map(conditionOf), match);
      if (query === latest.current) {
        setPreview(result);
      }
    }, PREVIEW_DELAY_MS);
    return () => clearTimeout(timer);
  }, [previewable, projectSlug, rows, match]);

  const wanted = [...new Set(rows.map((row) => row.property.trim()).filter((name) => name !== "" && !values.has(name)))].join("\n");
  useEffect(() => {
    if (!open || wanted === "") {
      return;
    }
    const timer = setTimeout(async () => {
      const found = await Promise.all(wanted.split("\n").map(async (name) => [name, await suggestValues(projectSlug, name)] as const));
      setValues((current) => new Map([...current, ...found.map(([name, result]) => [name, "values" in result ? result.values : []] as const)]));
    }, PREVIEW_DELAY_MS);
    return () => clearTimeout(timer);
  }, [open, projectSlug, wanted]);

  const change = (i: number, patch: Partial<Row>) => setRows((current) => current.map((row, j) => (j === i ? { ...row, ...patch } : row)));
  const shown = previewable ? preview : null;

  return (
    <Dialog open={open} onOpenChange={setOpen}>
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
                  <div className="flex items-center justify-between gap-2">
                    <span id={`group-conditions-${id}`} className="text-sm font-medium">
                      Conditions
                    </span>
                    <Select items={MATCHES} value={match} onValueChange={(next) => setMatch(next as Match)}>
                      <SelectTrigger size="sm" className="w-auto" aria-label="Which must match">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {(Object.keys(MATCHES) as Match[]).map((m) => (
                          <SelectItem key={m} value={m}>
                            {MATCHES[m]}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
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
                          {match === "any" ? "OR" : "AND"}
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
                            list={suggestsValues(row.op) ? `group-values-${id}-${i}` : undefined}
                            className="font-mono"
                          />
                        )}
                        {suggestsValues(row.op) && (
                          <datalist id={`group-values-${id}-${i}`}>
                            {(values.get(row.property.trim()) ?? []).map((value) => (
                              <option key={value} value={value} />
                            ))}
                          </datalist>
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
                  <input type="hidden" name="match" value={match} />
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
