import { CompassIcon } from "lucide-react";
import Link from "next/link";

import { PortalNotFoundMark } from "@/components/portal-menu";
import { MESSAGE_TEXT, MESSAGE_TITLE, PortalMessage } from "@/components/portal-message";
import { buttonVariants } from "@/components/ui/button";
import { portalLinks } from "@/server/portal-base";
import { cn } from "@/lib/utils";

/** A page of the portal that isn't there (a board, post, entry or article gone, or a mistyped address): in the portal's own header and footer, with the way home. */
export default async function PortalNotFound() {
  const at = await portalLinks();
  return (
    <PortalMessage icon={CompassIcon}>
      {/* The header and its menu mark no part as this page's, and no part's row shows. */}
      <PortalNotFoundMark />
      <p className="-mb-2 font-heading text-sm font-semibold text-primary">404</p>
      <h1 className={cn(MESSAGE_TITLE, "text-[1.75rem]")}>Page not found</h1>
      <p className={MESSAGE_TEXT}>It may have moved, or the link may be mistyped.</p>
      <Link href={at("/")} className={buttonVariants({ className: "mt-2" })}>
        Go to the home page
      </Link>
      <nav aria-label="Elsewhere" className="flex flex-wrap gap-x-4 gap-y-1 text-sm">
        <Link href={at("/roadmap")} className="text-muted-foreground hover:text-foreground hover:underline">
          Roadmap
        </Link>
        <Link href={at("/changelog")} className="text-muted-foreground hover:text-foreground hover:underline">
          Changelog
        </Link>
        <Link href={at("/docs")} className="text-muted-foreground hover:text-foreground hover:underline">
          Docs
        </Link>
      </nav>
    </PortalMessage>
  );
}
