import { serverCaller } from "@/server/trpc/server";

/** Every Settings page but Team & roles: owners and admins only (settings.access); anyone else gets a 404. */
export default async function AdminSettingsLayout({ children, params }: LayoutProps<"/app/[project]/settings">) {
  await (await serverCaller()).settings.access({ project: (await params).project });
  return children;
}
