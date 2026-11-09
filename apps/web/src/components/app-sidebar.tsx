"use client";

import type { TeamRole } from "@tuti/db";
import {
  ChevronsUpDownIcon,
  BookOpenIcon,
  ChartColumnIcon,
  ContactRoundIcon,
  ExternalLinkIcon,
  GitPullRequestIcon,
  HouseIcon,
  InboxIcon,
  type LucideIcon,
  LogOutIcon,
  MapIcon,
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
import { OPEN_COMMAND_MENU } from "@/lib/command-menu-event";
import { authClient } from "@/lib/auth-client";
import { useShortcutLabel } from "@/lib/shortcut-keys";
import { cn } from "@/lib/utils";
import { THEME_DEFAULT_KEY } from "@/lib/portal-look";

export type ProjectSummary = {
  slug: string;
  name: string;
  role: TeamRole;
  portalUrl: string;
  /** Its logo from Customize → Branding (one for dark mode too), or its favicon where the logo is wide; else its initial shows. */
  logo: string | null;
  logoDark: string | null;
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
  const onProject = Boolean(useParams<{ project?: string }>().project);
  const { setOpenMobile } = useSidebar();
  // On phones it's a menu over the page: a new page closes it.
  useEffect(() => setOpenMobile(false), [pathname, setOpenMobile]);
  useOpenCountInTitle(current?.openConversations ?? 0);
  const nav = current ? projectNav(current) : [];
  // The closest match is the current page: Roadmap, not Feedback, on /feedback/roadmap.
  const active = nav
    .flat()
    .filter((item) => pathname === item.href || (!!item.section && pathname.startsWith(`${item.href}/`)))
    .sort((a, b) => b.href.length - a.href.length)[0];

  return (
    <Sidebar collapsible="icon">
      <SidebarHeader>
        <ProjectSwitcher projects={projects} current={current} />
        {/* On a project's pages, where ⌘K is (not Account settings or New project). */}
        {onProject && <SearchButton />}
      </SidebarHeader>
      <SidebarContent>
        {nav.map((group, i) => (
          // Each group under the one before, a line between them (no gap down to the last).
          <SidebarGroup key={i} className={cn(i > 0 && "border-t border-sidebar-border/70")}>
            <SidebarGroupContent>
              <SidebarMenu>
                {group.map((item) => (
                  <SidebarMenuItem key={item.href}>
                    <SidebarMenuButton
                      isActive={item === active}
                      tooltip={item.title}
                      // Its count is read with it ("Feedback, 2 to triage").
                      render={<Link href={item.href} aria-describedby={item.badge ? countId(item.title) : undefined} />}
                    >
                      <item.icon />
                      <span>{item.title}</span>
                    </SidebarMenuButton>
                    {!!item.badge && (
                      <SidebarMenuBadge id={countId(item.title)} className={cn(item.badge.urgent && "bg-highlight text-highlight-foreground")}>
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
          <kbd aria-hidden className="rounded border bg-background px-1.5 font-sans text-xs text-muted-foreground group-data-[collapsible=icon]:hidden max-md:hidden">
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

type NavItem = { title: string; href: string; icon: LucideIcon; section?: boolean; badge?: { count: number; label: string; urgent?: boolean } | false };

/** The project's pages, in groups by how often each is used: the daily ones, then Users, then Customize and Settings. */
function projectNav(project: ProjectSummary): NavItem[][] {
  const base = `/app/${project.slug}`;
  const admin = project.role === "OWNER" || project.role === "ADMIN";
  // Counts where work waits.
  // `urgent`: people are waiting on the team (the Inbox), its count filled in the highlight colour.
  const waits = (count: number, label: string, urgent = false) => count > 0 && { count, label, urgent };
  return [
    [
      { title: "Home", href: base, icon: HouseIcon },
      { title: "Inbox", href: `${base}/inbox`, icon: MessagesSquareIcon, section: true, badge: waits(project.openConversations, "open", true) },
      // Its Boards (/feedback/boards) too.
      { title: "Feedback", href: `${base}/feedback`, icon: InboxIcon, section: true, badge: waits(project.toTriage, "to triage") },
      { title: "Roadmap", href: `${base}/feedback/roadmap`, icon: MapIcon },
      { title: "Changelog", href: `${base}/changelog`, icon: MegaphoneIcon },
      { title: "Docs", href: `${base}/docs`, icon: BookOpenIcon },
      { title: "Autopilot", href: `${base}/autopilot`, icon: GitPullRequestIcon, section: true, badge: waits(project.changesWaiting, "to review") },
    ],
    [
      { title: "Users", href: `${base}/users`, icon: ContactRoundIcon },
      { title: "Reporting", href: `${base}/reporting`, icon: ChartColumnIcon, section: true },
    ],
    [
      ...(admin ? [{ title: "Customize", href: `${base}/customize`, icon: PaintbrushIcon, section: true }] : []),
      // Every member's: Team & roles is in it.
      { title: "Settings", href: `${base}/settings`, icon: SettingsIcon, section: true },
    ],
  ];
}

/** The project's logo in a square (each in its own mode, if it has a dark one), or its initial. */
function ProjectMark({ project, className }: { project: ProjectSummary; className: string }) {
  if (!project.logo) {
    return (
      <div className={cn("flex shrink-0 items-center justify-center bg-sidebar-primary font-semibold text-sidebar-primary-foreground", className)}>
        {project.name.slice(0, 1).toUpperCase()}
      </div>
    );
  }
  // eslint-disable-next-line @next/next/no-img-element -- from media storage, already resized
  const image = (src: string, mode?: string) => <img src={src} alt="" className={cn("shrink-0 object-contain", className, mode)} />;
  return (
    <>
      {image(project.logo, project.logoDark ? "dark:hidden" : undefined)}
      {project.logoDark && image(project.logoDark, "hidden dark:block")}
    </>
  );
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
            <ProjectMark project={current} className="size-8 rounded-lg text-sm" />
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
                  <ProjectMark project={project} className="size-6 rounded-md text-xs" />
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
