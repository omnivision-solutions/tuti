"use client";

import { ZapIcon } from "lucide-react";
import { Suspense, use } from "react";

import { buttonVariants } from "@/components/ui/button";
import type { OneClickDns } from "@/server/domain-connect";

/**
 * "Add with Cloudflare" beside DNS records to copy, where the domain's DNS provider can add them
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
      <a href={found.url} title={`Your DNS is at ${found.provider}, which can add these records for you`} className={buttonVariants({ variant: "outline" })}>
        <ZapIcon className="text-highlight-foreground" />
        Add with {found.provider}
      </a>
    )
  );
}
