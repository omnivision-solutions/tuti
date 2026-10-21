import { createElement, type ReactNode } from "react";

import { lucideIcon } from "@/lib/lucide-icons";

type IconNode = [tag: string, attributes: object, children?: IconNode[]];
const draw = (nodes: IconNode[]): ReactNode[] => nodes.map(([tag, attributes, children]) => createElement(tag, attributes, ...draw(children ?? [])));

/**
 * A collection's Lucide icon for readers, as an inline SVG drawn on the server (a server component):
 * the portal sends no icon script. Sized and coloured by the text around it. Unknown names draw nothing.
 */
export async function CollectionIcon({ name }: { name: string | null }) {
  const icon = (await lucideIcon(name)?.())?.__iconData;
  if (!icon) {
    return null;
  }
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
      className={`lucide lucide-${name} size-[1.25em] shrink-0`}
    >
      {draw(icon.node)}
    </svg>
  );
}
