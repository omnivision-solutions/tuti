"use client";

import { LogOutIcon, UserIcon } from "lucide-react";
import Link from "next/link";
import { useTransition } from "react";
import { toast } from "sonner";

import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { usePortalAuthClient, usePortalHref } from "@/components/portal-base";

/**
 * Signs out of this portal (or the app) and goes to its home page, loaded afresh: nothing of the last reader's stays (the
 * widget the portal's loader added, outside React; the layout as it was for them, which a client navigation keeps).
 */
function useSignOut() {
  const at = usePortalHref();
  const authClient = usePortalAuthClient();
  return async () => {
    // Refused, or never sent (offline): still signed in, so they're told and stay where they are.
    const failed = await authClient.signOut().then(
      ({ error }) => Boolean(error),
      () => true,
    );
    if (failed) {
      toast.error("Couldn't sign you out. Try again.");
      return;
    }
    window.location.assign(at("/"));
  };
}

/** Sign out on a page (the portal's Account), as the account menu's. */
export function SignOutButton() {
  const signOut = useSignOut();
  const [pending, startTransition] = useTransition();
  return (
    <Button variant="outline" disabled={pending} focusableWhenDisabled onClick={() => startTransition(signOut)}>
      <LogOutIcon />
      Sign out
    </Button>
  );
}

export function UserMenu({ name, image, accountHref = "/account" }: { name: string; image: string | null; accountHref?: string }) {
  const at = usePortalHref();
  const signOut = useSignOut();
  const initials = name
    .split(/\s+/)
    .map((part) => part[0])
    .join("")
    .slice(0, 2)
    .toUpperCase();

  return (
    <DropdownMenu>
      <DropdownMenuTrigger render={<Button variant="ghost" size="icon" className="rounded-full" aria-label="Account" />}>
        <Avatar className="size-7">
          {image && <AvatarImage src={image} alt="" />}
          <AvatarFallback>{initials}</AvatarFallback>
        </Avatar>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-48">
        <DropdownMenuGroup>
          <DropdownMenuLabel className="truncate">{name}</DropdownMenuLabel>
        </DropdownMenuGroup>
        <DropdownMenuSeparator />
        <DropdownMenuItem render={<Link href={at(accountHref)} />}>
          <UserIcon />
          Account settings
        </DropdownMenuItem>
        <DropdownMenuItem onClick={signOut}>
          <LogOutIcon />
          Sign out
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
