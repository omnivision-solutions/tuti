import { notFound } from "next/navigation";

/**
 * Any portal address that matches no page (a mistyped one, an old link): the portal's own page not found (not-found.tsx
 * beside this), in its header and footer. Without it, an address no route matches gets Next's bare 404.
 */
export default function MissingPage() {
  notFound();
}
