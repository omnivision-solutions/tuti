"use client";

import { LogOutIcon, UserIcon } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useLocale, useTranslations } from "next-intl";
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

/** Signs out of this portal (or the app) and goes to its home page; `failed` says it couldn't. */
function useSignOut(failed: React.ReactNode) {
  const router = useRouter();
  const at = usePortalHref();
  const authClient = usePortalAuthClient();
  return async () => {
    // Refused, or never sent (offline): still signed in, so they're told and stay where they are.
    const refused = await authClient.signOut().then(
      ({ error }) => Boolean(error),
      () => true,
    );
    if (refused) {
      toast.error(failed);
      return;
    }
    router.push(at("/"));
    router.refresh();
  };
}

/** Sign out on a page (the portal's Account, a quiet text button at the end of its Profile row), as the account menu's. */
// Its text moves to the messages with the Account page's (L5).
export function SignOutButton() {
  const signOut = useSignOut("Couldn't sign you out. Try again.");
  const [pending, startTransition] = useTransition();
  return (
    <Button variant="ghost" className="shrink-0" disabled={pending} focusableWhenDisabled onClick={() => startTransition(signOut)}>
      Sign out
    </Button>
  );
}

export function UserMenu({ name, image, accountHref = "/account" }: { name: string; image: string | null; accountHref?: string }) {
  const at = usePortalHref();
  const t = useTranslations("header");
  // In the reader's language, until <html lang> follows it (L3).
  const lang = useLocale();
  const signOut = useSignOut(<span lang={lang}>{t("signOutFailed")}</span>);
  const initials = name
    .split(/\s+/)
    .map((part) => part[0])
    .join("")
    .slice(0, 2)
    .toUpperCase();

  return (
    <DropdownMenu>
      <DropdownMenuTrigger render={<Button variant="ghost" size="icon" className="rounded-full" lang={lang} aria-label={t("account")} />}>
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
        <DropdownMenuItem lang={lang} render={<Link href={at(accountHref)} />}>
          <UserIcon />
          {t("accountSettings")}
        </DropdownMenuItem>
        <DropdownMenuItem lang={lang} onClick={signOut}>
          <LogOutIcon />
          {t("signOut")}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
