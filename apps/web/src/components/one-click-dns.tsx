"use client";

import { Suspense, use } from "react";

import { buttonVariants } from "@/components/ui/button";
import type { OneClickDns } from "@/server/domain-connect";

/**
 * "Add with Cloudflare" above DNS records to copy, where the domain's DNS provider can add them
 * itself (server/domain-connect.ts). Its lookup doesn't hold up the page: nothing shows until it's in.
 */
export function OneClickDnsButton({ link }: { link?: Promise<OneClickDns | null> | null }) {
  return (
    link && (
      <Suspense>
        <Found link={link} />
      </Suspense>
    )
  );
}

function Found({ link }: { link: Promise<OneClickDns | null> }) {
  const found = use(link);
  return (
    found && (
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border p-3">
        <p className="text-sm text-muted-foreground">Your DNS is at {found.provider}, which can add these records for you.</p>
        <a href={found.url} className={buttonVariants({ variant: "outline" })}>
          Add with {found.provider}
        </a>
      </div>
    )
  );
}
