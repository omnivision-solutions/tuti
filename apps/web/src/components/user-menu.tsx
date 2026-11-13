"use client";

import { LogOutIcon, UserIcon } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
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

/** Signs out of this portal (or the app) and goes to its home page. */
function useSignOut() {
  const router = useRouter();
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
    router.push(at("/"));
    router.refresh();
  };
}

/** Sign out on a page (the portal's Account, a quiet text button at the end of its Profile row), as the account menu's. */
export function SignOutButton() {
  const signOut = useSignOut();
  const [pending, startTransition] = useTransition();
  return (
    <Button variant="ghost" className="shrink-0" disabled={pending} focusableWhenDisabled onClick={() => startTransition(signOut)}>
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
