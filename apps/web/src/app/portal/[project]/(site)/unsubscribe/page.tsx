import { Button } from "@/components/ui/button";
import { findOptOut } from "@/server/unsubscribe";
import { portalLinks } from "@/server/portal-base";

export default async function UnsubscribePage(props: PageProps<"/portal/[project]/unsubscribe">) {
  const [{ project: slug }, { token }] = await Promise.all([props.params, props.searchParams]);
  const value = typeof token === "string" ? token : "";
  const found = await findOptOut(slug, value);

  return (
    <div className="mx-auto flex w-full max-w-md flex-col gap-4 py-12">
      {!found ? (
        <>
          <h1 className="font-heading text-2xl font-bold">This link doesn&apos;t work</h1>
          <p className="text-muted-foreground">Use the unsubscribe link from the latest email you got.</p>
        </>
      ) : found.optedOut ? (
        <>
          <h1 className="font-heading text-2xl font-bold">You&apos;re unsubscribed</h1>
          <p className="text-muted-foreground">{found.project.name} won&apos;t email you anymore.</p>
        </>
      ) : (
        <>
          <h1 className="font-heading text-2xl font-bold">Stop emails from {found.project.name}?</h1>
          <p className="text-muted-foreground">
            You won&apos;t hear from {found.project.name} when posts you asked for are done.
          </p>
          <form method="post" action={(await portalLinks())(`/unsubscribe/confirm?token=${encodeURIComponent(value)}`)}>
            <Button type="submit">Unsubscribe</Button>
          </form>
        </>
      )}
    </div>
  );
}
