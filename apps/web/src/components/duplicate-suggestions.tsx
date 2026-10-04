"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useTransition } from "react";
import { toast } from "sonner";

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
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { dismissDuplicate, mergePost } from "@/server/manage-posts";

type PostRef = { id: string; number: number; title: string; voteCount: number };

export type Suggestion = {
  id: string;
  similarity: number;
  /** The newer post, merged into `original`. */
  duplicate: PostRef;
  original: PostRef;
};

/** Team post view: posts the worker thinks duplicate this one (or that this one duplicates). */
export function DuplicateSuggestions({
  projectSlug,
  postId,
  suggestions,
}: {
  projectSlug: string;
  postId: string;
  suggestions: Suggestion[];
}) {
  return (
    <Card size="sm">
      <CardHeader>
        <CardTitle>Possible duplicates</CardTitle>
        <CardDescription>Found by comparing what the posts say. Merge them, or mark them as different.</CardDescription>
      </CardHeader>
      <CardContent>
        <ItemList>
          {suggestions.map((s) => (
            <SuggestionRow key={s.id} projectSlug={projectSlug} postId={postId} suggestion={s} />
          ))}
        </ItemList>
      </CardContent>
    </Card>
  );
}

function SuggestionRow({ projectSlug, postId, suggestion }: { projectSlug: string; postId: string; suggestion: Suggestion }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const { duplicate, original } = suggestion;
  const other = duplicate.id === postId ? original : duplicate;
  const isDuplicate = duplicate.id === postId;

  const merge = () =>
    startTransition(async () => {
      const result = await mergePost(projectSlug, duplicate.id, original.id);
      if (result.error) {
        toast.error(result.error);
        return;
      }
      toast.success(`Merged #${duplicate.number} into #${original.number}`);
      if (isDuplicate) {
        router.push(`/app/${projectSlug}/p/${original.number}`);
      }
    });

  const dismiss = () =>
    startTransition(async () => {
      const result = await dismissDuplicate(projectSlug, suggestion.id);
      if (result.error) {
        toast.error(result.error);
      }
    });

  return (
    <ItemRow
      wideActions
      title={
        <Link href={`/app/${projectSlug}/p/${other.number}`} className="hover:underline">
          {other.title}
        </Link>
      }
      meta={
        <>
          #{other.number} · {other.voteCount} {other.voteCount === 1 ? "vote" : "votes"} ·{" "}
          {Math.round(suggestion.similarity * 100)}% similar
        </>
      }
      actions={
        <>
          <Button variant="ghost" size="sm" disabled={pending} onClick={dismiss}>
            Not a duplicate
          </Button>
          <AlertDialog>
            <AlertDialogTrigger render={<Button variant="outline" size="sm" disabled={pending} />}>
              {isDuplicate ? `Merge into #${original.number}` : `Merge #${duplicate.number} into this`}
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>
                  Merge #{duplicate.number} into #{original.number}?
                </AlertDialogTitle>
                <AlertDialogDescription>
                  “{duplicate.title}” will be merged into “{original.title}”. Its votes (counted once per person) and
                  comments move over, and its link will point to #{original.number}. This can&apos;t be undone.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>Cancel</AlertDialogCancel>
                <AlertDialogAction onClick={merge}>Merge</AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </>
      }
    />
  );
}
