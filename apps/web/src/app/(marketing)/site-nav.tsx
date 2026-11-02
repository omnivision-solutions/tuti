"use client";

import { NavigationMenu } from "@base-ui/react/navigation-menu";
import {
  BookOpenIcon,
  ChevronDownIcon,
  CodeIcon,
  FilePenLineIcon,
  LockIcon,
  MapIcon,
  MegaphoneIcon,
  MessageCircleIcon,
  NewspaperIcon,
  SearchIcon,
  SparklesIcon,
  SquareCheckIcon,
  ThumbsUpIcon,
} from "lucide-react";

import { GithubMark } from "@/components/github-mark";
import { buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";

type Feature = { icon: (props: { className?: string }) => React.ReactNode; title: string; text: string; href: string };

/** The features menu's columns. Each feature points at the part of the home page (or the docs) that shows it. */
function columns(docs: string): { title: string; features: Feature[] }[] {
  return [
    {
      title: "Help center",
      features: [
        { icon: BookOpenIcon, title: "Hosted help center", text: "Your domain or a path of your site", href: "/#features" },
        { icon: SparklesIcon, title: "AI answers", text: "Instant answers, with sources", href: "/#features" },
        { icon: MessageCircleIcon, title: "In-app widget", text: "Help inside your product", href: "/#features" },
        { icon: LockIcon, title: "Private docs", text: "Single sign-on and reader groups", href: "/#features" },
        { icon: SearchIcon, title: "Search insights", text: "See what customers can't find", href: "/#features" },
      ],
    },
    {
      title: "Autopilot",
      features: [
        { icon: FilePenLineIcon, title: "Articles fix themselves", text: "Rewritten when you ship", href: "/#autopilot" },
        { icon: SquareCheckIcon, title: "Feature requests, closed out", text: "Marked done, everyone told", href: "/#autopilot" },
        { icon: NewspaperIcon, title: "Changelog, drafted", text: "From what you shipped", href: "/#autopilot" },
      ],
    },
    {
      title: "Feedback",
      features: [
        { icon: ThumbsUpIcon, title: "Feedback boards", text: "Customers vote on feature requests", href: "/#connected" },
        { icon: MapIcon, title: "Roadmap", text: "Planned, in progress, shipped", href: "/#connected" },
        { icon: MegaphoneIcon, title: "Changelog", text: "Emailed to subscribers", href: "/#connected" },
        { icon: GithubMark, title: "GitHub", text: "Reads each change you ship", href: "/#autopilot" },
        { icon: CodeIcon, title: "API and MCP", text: "Build on Tuti, or work from Claude", href: docs },
      ],
    },
  ];
}

const LINK = buttonVariants({ variant: "ghost", className: "text-[15px] font-medium" });

/** The site's middle links: a features menu, then Pricing and Docs. On phones none fit beside the sign-in buttons;
 * the home page's footer has Pricing and Docs. */
export function SiteNav({ docs, pricing }: { docs: string; pricing: boolean }) {
  return (
    <NavigationMenu.Root aria-label="Site" className="max-sm:hidden">
      <NavigationMenu.List className="flex items-center gap-1">
        <NavigationMenu.Item className="max-md:hidden">
          <NavigationMenu.Trigger className={cn(LINK, "group data-popup-open:bg-muted")}>
            Features
            <NavigationMenu.Icon className="transition-transform group-data-popup-open:rotate-180">
              <ChevronDownIcon className="size-4" />
            </NavigationMenu.Icon>
          </NavigationMenu.Trigger>
          <NavigationMenu.Content className="w-[min(60rem,calc(100vw-3rem))]">
            <div className="grid gap-8 p-8 md:grid-cols-3">
              {columns(docs).map((column) => (
                <div key={column.title}>
                  <p className="text-xs font-bold tracking-wider text-soft-foreground uppercase">{column.title}</p>
                  <ul className="mt-4 flex flex-col gap-1">
                    {column.features.map((feature) => (
                      <li key={feature.title}>
                        <NavigationMenu.Link href={feature.href} className="-mx-2 flex items-start gap-3 rounded-lg p-2 hover:bg-muted focus-visible:bg-muted focus-visible:outline-none">
                          <span className="flex size-9 shrink-0 items-center justify-center rounded-lg border bg-background shadow-xs">
                            <feature.icon className="size-4" />
                          </span>
                          <span className="flex flex-col">
                            <span className="font-medium">{feature.title}</span>
                            <span className="text-sm text-muted-foreground">{feature.text}</span>
                          </span>
                        </NavigationMenu.Link>
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
            </div>
            {pricing && (
              <p className="border-t bg-muted/40 px-8 py-4 text-sm">
                Free to start, Autopilot included.{" "}
                <NavigationMenu.Link href="/pricing" className="font-semibold text-soft-foreground hover:underline">
                  See pricing →
                </NavigationMenu.Link>
              </p>
            )}
          </NavigationMenu.Content>
        </NavigationMenu.Item>
        {pricing && (
          <NavigationMenu.Item>
            <NavigationMenu.Link href="/pricing" className={LINK}>
              Pricing
            </NavigationMenu.Link>
          </NavigationMenu.Item>
        )}
        <NavigationMenu.Item className="max-md:hidden">
          <NavigationMenu.Link href={docs} className={LINK}>
            Docs
          </NavigationMenu.Link>
        </NavigationMenu.Item>
      </NavigationMenu.List>
      <NavigationMenu.Portal>
        <NavigationMenu.Positioner sideOffset={10} collisionPadding={24} className="z-50">
          <NavigationMenu.Popup className="overflow-hidden rounded-2xl border bg-popover text-popover-foreground shadow-xl duration-150 data-ending-style:opacity-0 data-starting-style:opacity-0">
            <NavigationMenu.Viewport />
          </NavigationMenu.Popup>
        </NavigationMenu.Positioner>
      </NavigationMenu.Portal>
    </NavigationMenu.Root>
  );
}
