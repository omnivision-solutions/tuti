"use client";

import { useActionState, useRef, useState, useTransition } from "react";
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
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { keepingFields } from "@/lib/forms";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { createBoard, deleteBoard, updateBoard } from "@/server/boards";
import type { FormState } from "@/server/form-state";

function slugify(value: string) {
  return value
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
}

export function CreateBoardForm({ projectSlug }: { projectSlug: string }) {
  const formRef = useRef<HTMLFormElement>(null);
  const [slug, setSlug] = useState("");
  const [slugEdited, setSlugEdited] = useState(false);
  const [state, action, pending] = useActionState<FormState, FormData>(async (prev, formData) => {
    const result = await createBoard(projectSlug, prev, formData);
    if (!result.error) {
      formRef.current?.reset();
      setSlug("");
      setSlugEdited(false);
      toast.success("Board created");
    }
    return result;
  }, {});

  return (
    <form ref={formRef} {...keepingFields(action)}>
      <FieldGroup>
        <Field>
          <FieldLabel htmlFor="board-name">Name</FieldLabel>
          <Input
            id="board-name"
            name="name"
            placeholder="Bug reports"
            required
            onChange={(e) => !slugEdited && setSlug(slugify(e.target.value))}
          />
        </Field>
        <Field data-invalid={state.error ? true : undefined}>
          <FieldLabel htmlFor="board-slug">URL</FieldLabel>
          <Input
            id="board-slug"
            name="slug"
            value={slug}
            onChange={(e) => {
              setSlug(e.target.value);
              setSlugEdited(true);
            }}
            required
            aria-invalid={state.error ? true : undefined}
          />
          <FieldDescription>On your portal at /b/{slug || "<url>"}.</FieldDescription>
          {state.error && <FieldError>{state.error}</FieldError>}
        </Field>
        <Field>
          <FieldLabel htmlFor="board-description">Description</FieldLabel>
          <Textarea id="board-description" name="description" rows={2} placeholder="Optional, shown on the board" />
        </Field>
        <Button type="submit" disabled={pending} className="self-start">
          {pending ? "Creating…" : "Create board"}
        </Button>
      </FieldGroup>
    </form>
  );
}

export function EditBoardDialog({
  projectSlug,
  board,
}: {
  projectSlug: string;
  board: { id: string; name: string; slug: string; description: string | null };
}) {
  const [open, setOpen] = useState(false);
  const [state, action, pending] = useActionState<FormState, FormData>(
    async (prev, formData) => {
      const result = await updateBoard(projectSlug, board.id, prev, formData);
      if (!result.error) {
        setOpen(false);
        toast.success("Board updated");
      }
      return result;
    },
    {},
  );

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger render={<Button variant="ghost" size="sm" />}>Edit</DialogTrigger>
      <DialogContent>
        <form {...keepingFields(action)}>
          <DialogHeader>
            <DialogTitle>Edit board</DialogTitle>
            <DialogDescription>If you change the URL, links to the old one keep working.</DialogDescription>
          </DialogHeader>
          <FieldGroup className="my-4">
            <Field>
              <FieldLabel htmlFor={`name-${board.id}`}>Name</FieldLabel>
              <Input id={`name-${board.id}`} name="name" defaultValue={board.name} required />
            </Field>
            <Field data-invalid={state.error ? true : undefined}>
              <FieldLabel htmlFor={`slug-${board.id}`}>URL</FieldLabel>
              <Input id={`slug-${board.id}`} name="slug" defaultValue={board.slug} required />
              <FieldDescription>On your portal at /b/&lt;url&gt;.</FieldDescription>
              {state.error && <FieldError>{state.error}</FieldError>}
            </Field>
            <Field>
              <FieldLabel htmlFor={`description-${board.id}`}>Description</FieldLabel>
              <Textarea id={`description-${board.id}`} name="description" rows={2} defaultValue={board.description ?? ""} />
            </Field>
          </FieldGroup>
          <DialogFooter>
            <Button type="submit" disabled={pending}>
              Save
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function DeleteBoardButton({ projectSlug, boardId, name }: { projectSlug: string; boardId: string; name: string }) {
  const [pending, startTransition] = useTransition();
  return (
    <AlertDialog>
      <AlertDialogTrigger render={<Button variant="ghost" size="sm" disabled={pending} />}>Delete</AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete {name}?</AlertDialogTitle>
          <AlertDialogDescription>The board is removed from your portal. It has no posts.</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction
            variant="destructive"
            onClick={() =>
              startTransition(async () => {
                const result = await deleteBoard(projectSlug, boardId);
                if (result.error) {
                  toast.error(result.error);
                } else {
                  toast.success(`${name} deleted`);
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
