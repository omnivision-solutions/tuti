"use client";

import { useActionState, useState, useTransition } from "react";
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
import { Textarea } from "@/components/ui/textarea";
import { keepingFields } from "@/lib/forms";
import type { FormState } from "@/server/form-state";
import { deleteGroup, saveGroup } from "@/server/groups";
import type { GroupView } from "@/server/operations/groups";

/** Settings → Groups: the project's reader groups, with how many readers are in each. */
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
                  <code className="break-all">{group.claim}</code>
                  {` · ${group.readers} ${group.readers === 1 ? "reader" : "readers"}${group.description && ` · ${group.description}`}`}
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

/** Adds a group, or (with `group`) changes one. */
function GroupDialog({ projectSlug, group }: { projectSlug: string; group?: GroupView }) {
  const [open, setOpen] = useState(false);
  const [state, action, pending] = useActionState<FormState, FormData>(async (prev, formData) => {
    const result = await saveGroup(projectSlug, group?.key ?? null, prev, formData);
    if (!result.error) {
      setOpen(false);
      toast.success(group ? "Group saved" : "Group added");
    }
    return result;
  }, {});
  const id = group?.key ?? "new";

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger
        render={<Button variant={group ? "ghost" : "outline"} size="sm" aria-label={group ? `Edit ${group.name}` : undefined} />}
      >
        {group ? "Edit" : "New group"}
      </DialogTrigger>
      <DialogContent>
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
              <FieldLabel htmlFor={`group-claim-${id}`}>Claim</FieldLabel>
              <Input
                id={`group-claim-${id}`}
                name="claim"
                defaultValue={group?.claim ?? undefined}
                placeholder={group ? undefined : "From the name"}
                maxLength={50}
                autoComplete="off"
              />
              <FieldDescription>
                Readers are in this group when your app signs them in with this in the token&apos;s <code>groups</code>.
                {group && " Changing it changes who's in it."}
              </FieldDescription>
            </Field>
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
