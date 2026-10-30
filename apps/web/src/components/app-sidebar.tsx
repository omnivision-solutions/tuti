"use client";

import type { TeamRole } from "@tuti/db";
import {
  ChevronsUpDownIcon,
  BookOpenIcon,
  ContactRoundIcon,
  ExternalLinkIcon,
  GitPullRequestIcon,
  HouseIcon,
  InboxIcon,
  type LucideIcon,
  LogOutIcon,
  MegaphoneIcon,
  MessagesSquareIcon,
  MonitorIcon,
  MoonIcon,
  PaintbrushIcon,
  PlusIcon,
  SearchIcon,
  SettingsIcon,
  SunIcon,
  UserIcon,
} from "lucide-react";
import Link from "next/link";
import { useParams, usePathname, useRouter } from "next/navigation";
import { useTheme } from "next-themes";
import { useEffect } from "react";

import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarRail,
  useSidebar,
} from "@/components/ui/sidebar";
import { OPEN_COMMAND_MENU } from "@/components/command-menu";
import { authClient } from "@/lib/auth-client";
import { useShortcutLabel } from "@/lib/shortcut-keys";
import { cn } from "@/lib/utils";
import { THEME_DEFAULT_KEY } from "@/lib/portal-look";

export type ProjectSummary = {
  slug: string;
  name: string;
  role: TeamRole;
  portalUrl: string;
  openConversations: number;
  /** Posts waiting for triage (Open). */
  toTriage: number;
  /** Code changes with updates waiting for the team. */
  changesWaiting: number;
};

/** Shared by every /app page. The current project comes from the URL, else the last one opened. */
export function AppSidebar({
  projects,
  fallbackSlug,
  user,
}: {
  projects: ProjectSummary[];
  fallbackSlug: string | null;
  user: { name: string; email: string; image: string | null };
}) {
  const pathname = usePathname();
  const current = useCurrentProject(projects, fallbackSlug);
  const { setOpenMobile } = useSidebar();
  // On phones it's a menu over the page: a new page closes it.
  useEffect(() => setOpenMobile(false), [pathname, setOpenMobile]);
  useOpenCountInTitle(current?.openConversations ?? 0);

  return (
    <Sidebar collapsible="icon">
      <SidebarHeader>
        <ProjectSwitcher projects={projects} current={current} />
        {current && <SearchButton />}
      </SidebarHeader>
      <SidebarContent>
        {current &&
          projectNav(current).map((group, i) => (
            // The last group (Customize, Settings) sits at the bottom.
            <SidebarGroup key={i} className={cn(i === 2 && "mt-auto")}>
              <SidebarGroupContent>
                <SidebarMenu>
                  {group.map((item) => (
                    <SidebarMenuItem key={item.href}>
                      <SidebarMenuButton
                        isActive={pathname === item.href || (!!item.section && pathname.startsWith(`${item.href}/`))}
                        tooltip={item.title}
                        // Its count is read with it ("Feedback, 2 to triage").
                        render={<Link href={item.href} aria-describedby={item.badge ? countId(item.title) : undefined} />}
                      >
                        <item.icon />
                        <span>{item.title}</span>
                      </SidebarMenuButton>
                      {!!item.badge && (
                        <SidebarMenuBadge id={countId(item.title)}>
                          {item.badge.count}
                          <span className="sr-only"> {item.badge.label}</span>
                        </SidebarMenuBadge>
                      )}
                    </SidebarMenuItem>
                  ))}
                </SidebarMenu>
              </SidebarGroupContent>
            </SidebarGroup>
          ))}
      </SidebarContent>
      <SidebarFooter>
        <NavUser user={user} />
      </SidebarFooter>
      <SidebarRail />
    </Sidebar>
  );
}

/** Opens ⌘K (components/command-menu.tsx), saying its shortcut as this platform writes it. */
function SearchButton() {
  const shortcut = useShortcutLabel("K");
  return (
    <SidebarMenu>
      <SidebarMenuItem>
        <SidebarMenuButton tooltip={`Search (${shortcut})`} onClick={() => window.dispatchEvent(new Event(OPEN_COMMAND_MENU))}>
          <SearchIcon />
          <span className="flex-1">Search</span>
          <kbd aria-hidden className="rounded border bg-background px-1.5 font-sans text-xs text-muted-foreground group-data-[collapsible=icon]:hidden">
            {shortcut}
          </kbd>
        </SidebarMenuButton>
      </SidebarMenuItem>
    </SidebarMenu>
  );
}

function initials(name: string) {
  return name
    .split(/\s+/)
    .map((part) => part[0])
    .join("")
    .slice(0, 2)
    .toUpperCase();
}

/** "(3) Inbox": the open conversations before every page's title, kept there as pages change it. */
function useOpenCountInTitle(count: number) {
  useEffect(() => {
    const apply = () => {
      const base = document.title.replace(/^\(\d+\) /, "");
      const next = count > 0 ? `(${count}) ${base}` : base;
      if (document.title !== next) {
        document.title = next;
      }
    };
    apply();
    const observer = new MutationObserver(apply);
    observer.observe(document.head, { childList: true, subtree: true, characterData: true });
    return () => {
      observer.disconnect();
      document.title = document.title.replace(/^\(\d+\) /, "");
    };
  }, [count]);
}

export function useCurrentProject(projects: ProjectSummary[], fallbackSlug: string | null) {
  const params = useParams<{ project?: string }>();
  const slug = params.project ?? fallbackSlug;
  return projects.find((p) => p.slug === slug) ?? null;
}

/** A portal's address without its scheme: its host, and its path where it's under a site's (acme.com/portal). */
const portalLabel = (url: string) => {
  const { host, pathname } = new URL(url);
  return `${host}${pathname.replace(/\/$/, "")}`;
};

const countId = (title: string) => `nav-count-${title.toLowerCase().replace(/\W+/g, "-")}`;

type NavItem = { title: string; href: string; icon: LucideIcon; section?: boolean; badge?: { count: number; label: string } | false };

/** The project's pages, in groups by how often each is used: the daily ones, then Users, then Customize and Settings. */
function projectNav(project: ProjectSummary): NavItem[][] {
  const base = `/app/${project.slug}`;
  const admin = project.role === "OWNER" || project.role === "ADMIN";
  // Counts where work waits.
  const waits = (count: number, label: string) => count > 0 && { count, label };
  return [
    [
      { title: "Home", href: base, icon: HouseIcon },
      { title: "Inbox", href: `${base}/inbox`, icon: MessagesSquareIcon, section: true, badge: waits(project.openConversations, "open") },
      // Its Boards (/feedback/boards) too.
      { title: "Feedback", href: `${base}/feedback`, icon: InboxIcon, section: true, badge: waits(project.toTriage, "to triage") },
      { title: "Changelog", href: `${base}/changelog`, icon: MegaphoneIcon },
      { title: "Docs", href: `${base}/docs`, icon: BookOpenIcon },
      { title: "Code changes", href: `${base}/code-changes`, icon: GitPullRequestIcon, section: true, badge: waits(project.changesWaiting, "waiting") },
    ],
    [{ title: "Users", href: `${base}/users`, icon: ContactRoundIcon }],
    [
      ...(admin ? [{ title: "Customize", href: `${base}/customize`, icon: PaintbrushIcon, section: true }] : []),
      // Every member's: Team & roles is in it.
      { title: "Settings", href: `${base}/settings`, icon: SettingsIcon, section: true },
    ],
  ];
}

function ProjectSwitcher({ projects, current }: { projects: ProjectSummary[]; current: ProjectSummary | null }) {
  const { isMobile } = useSidebar();

  if (!current) {
    return (
      <SidebarMenu>
        <SidebarMenuItem>
          <SidebarMenuButton size="lg" render={<Link href="/app/new" />}>
            <div className="flex aspect-square size-8 items-center justify-center rounded-lg border">
              <PlusIcon className="size-4" />
            </div>
            <span className="font-medium">Create a project</span>
          </SidebarMenuButton>
        </SidebarMenuItem>
      </SidebarMenu>
    );
  }

  return (
    <SidebarMenu>
      <SidebarMenuItem>
        <DropdownMenu>
          <DropdownMenuTrigger
            render={<SidebarMenuButton size="lg" className="data-popup-open:bg-sidebar-accent" />}
          >
            <div className="flex aspect-square size-8 items-center justify-center rounded-lg bg-sidebar-primary text-sm font-semibold text-sidebar-primary-foreground">
              {current.name.slice(0, 1).toUpperCase()}
            </div>
            <div className="grid flex-1 text-left text-sm leading-tight">
              <span className="truncate font-medium">{current.name}</span>
              <span className="truncate text-xs text-muted-foreground">{portalLabel(current.portalUrl)}</span>
            </div>
            <ChevronsUpDownIcon className="ml-auto" />
          </DropdownMenuTrigger>
          <DropdownMenuContent
            className="min-w-56"
            align="start"
            side={isMobile ? "bottom" : "right"}
            sideOffset={4}
          >
            <DropdownMenuItem render={<a href={current.portalUrl} target="_blank" rel="noreferrer" />}>
              <ExternalLinkIcon />
              <span className="flex min-w-0 flex-col">
                View portal
                <span className="truncate text-xs text-muted-foreground">{portalLabel(current.portalUrl)}</span>
              </span>
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuGroup>
              <DropdownMenuLabel className="text-xs text-muted-foreground">Projects</DropdownMenuLabel>
              {projects.map((project) => (
                <DropdownMenuItem key={project.slug} render={<Link href={`/app/${project.slug}`} />}>
                  <div className="flex size-6 items-center justify-center rounded-md border text-xs font-semibold">
                    {project.name.slice(0, 1).toUpperCase()}
                  </div>
                  <span className="truncate">{project.name}</span>
                  {project.slug === current.slug && <span className="ml-auto text-xs text-muted-foreground">Current</span>}
                </DropdownMenuItem>
              ))}
            </DropdownMenuGroup>
            <DropdownMenuSeparator />
            <DropdownMenuItem render={<Link href="/app/new" />}>
              <div className="flex size-6 items-center justify-center rounded-md border">
                <PlusIcon className="size-4" />
              </div>
              Add project
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </SidebarMenuItem>
    </SidebarMenu>
  );
}

function NavUser({ user }: { user: { name: string; email: string; image: string | null } }) {
  const { isMobile } = useSidebar();
  const router = useRouter();
  const { theme, setTheme } = useTheme();

  return (
    <SidebarMenu>
      <SidebarMenuItem>
        <DropdownMenu>
          <DropdownMenuTrigger
            render={<SidebarMenuButton size="lg" className="data-popup-open:bg-sidebar-accent" />}
          >
            <Avatar className="size-8 rounded-lg">
              {user.image && <AvatarImage src={user.image} alt="" />}
              <AvatarFallback className="rounded-lg">{initials(user.name)}</AvatarFallback>
            </Avatar>
            <div className="grid flex-1 text-left text-sm leading-tight">
              <span className="truncate font-medium">{user.name}</span>
              <span className="truncate text-xs text-muted-foreground">{user.email}</span>
            </div>
            <ChevronsUpDownIcon className="ml-auto size-4" />
          </DropdownMenuTrigger>
          <DropdownMenuContent className="min-w-56" side={isMobile ? "bottom" : "right"} align="end" sideOffset={4}>
            <DropdownMenuItem render={<Link href="/app/account" />}>
              <UserIcon />
              Account settings
            </DropdownMenuItem>
            <DropdownMenuSub>
              <DropdownMenuSubTrigger>
                <SunIcon />
                Theme
              </DropdownMenuSubTrigger>
              <DropdownMenuSubContent>
                <DropdownMenuRadioGroup
                  value={theme ?? "system"}
                  onValueChange={(value) => {
                    // Their own pick, not a portal's default (see ColorSchemeScript).
                    localStorage.removeItem(THEME_DEFAULT_KEY);
                    setTheme(String(value));
                  }}
                >
                  <DropdownMenuRadioItem value="light">
                    <SunIcon />
                    Light
                  </DropdownMenuRadioItem>
                  <DropdownMenuRadioItem value="dark">
                    <MoonIcon />
                    Dark
                  </DropdownMenuRadioItem>
                  <DropdownMenuRadioItem value="system">
                    <MonitorIcon />
                    System
                  </DropdownMenuRadioItem>
                </DropdownMenuRadioGroup>
              </DropdownMenuSubContent>
            </DropdownMenuSub>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              onClick={async () => {
                await authClient.signOut();
                router.push("/");
                router.refresh();
              }}
            >
              <LogOutIcon />
              Sign out
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </SidebarMenuItem>
    </SidebarMenu>
  );
}
