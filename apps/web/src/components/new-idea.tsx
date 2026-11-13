"use client";

import { PlusIcon } from "lucide-react";
import { createContext, useContext, useEffect, useState } from "react";

import { NewPostForm } from "@/components/new-post-form";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";

const OpenContext = createContext<(() => void) | null>(null);

/**
 * A board's "New idea": one dialog for the page, with the board's form (signed out, its title and "Sign in to post",
 * which comes back here with the title), opened by any NewIdeaButton or NewIdeaLink in it. Open as the page loads when
 * the address brings a title (`defaultTitle`: back from signing in, or "Post this as feedback" from the docs), or asks for
 * it (`opened`: `?new`, a post's "Have another idea?").
 */
export function NewIdea({
  signedIn,
  opened = false,
  children,
  ...form
}: { signedIn: boolean; opened?: boolean; children: React.ReactNode } & Omit<React.ComponentProps<typeof NewPostForm>, "collapsible" | "signedOut" | "onPosted">) {
  const [open, setOpen] = useState(opened || !!form.defaultTitle);
  // Opened by the address: it asks once. Without `new` and `title` in it now (replaced, not a new entry), a reload or Back
  // doesn't open it again, nor bring back a title already posted.
  useEffect(() => {
    const url = new URL(window.location.href);
    if (url.searchParams.has("new") || url.searchParams.has("title")) {
      url.searchParams.delete("new");
      url.searchParams.delete("title");
      // Not Next's own history state (its `__NA` would make Next keep the old address in its router): null, which Next
      // takes as the page's own change and follows.
      window.history.replaceState(null, "", url);
    }
  }, []);
  return (
    <OpenContext value={() => setOpen(true)}>
      {children}
      <Dialog open={open} onOpenChange={setOpen}>
        {/* Kept while closed: a half-written idea is still there when it opens again. Near the top, not centred by a transform:
            a transform would be the editor's floating toolbar's frame (it's fixed), putting it out of place. */}
        <DialogContent keepMounted className="top-[8vh] right-0 left-0 mx-auto translate-none gap-3 p-5 sm:max-w-xl">
          <DialogHeader>
            <DialogTitle className="text-lg">Share an idea</DialogTitle>
          </DialogHeader>
          <NewPostForm {...form} signedOut={!signedIn} collapsible={!signedIn} onPosted={() => setOpen(false)} />
        </DialogContent>
      </Dialog>
    </OpenContext>
  );
}

/** The board's primary (`label`: its own button text, Boards → Button, or "New post"): opens the page's NewIdea. `round`: a round + named by it (phones). */
export function NewIdeaButton({ label, round = false }: { label: string; round?: boolean }) {
  const open = useContext(OpenContext);
  return round ? (
    <Button onClick={() => open?.()} size="icon-lg" aria-label={label} className="rounded-full">
      <PlusIcon />
    </Button>
  ) : (
    <Button onClick={() => open?.()} className="font-semibold">
      <PlusIcon />
      {label}
    </Button>
  );
}

/** A link-styled button that opens the page's NewIdea (`children`: its words). */
export function NewIdeaLink({ children }: { children: React.ReactNode }) {
  const open = useContext(OpenContext);
  return (
    <button type="button" onClick={() => open?.()} className="font-medium text-foreground underline decoration-primary/55 decoration-[1.5px] underline-offset-[3px] hover:decoration-primary">
      {children}
    </button>
  );
}
