/** The address for anything about tuti.so's terms and privacy. */
export const CONTACT_EMAIL = "hello@tuti.so";

export const contact = (
  <a href={`mailto:${CONTACT_EMAIL}`} className="font-medium text-primary underline-offset-4 hover:underline">
    {CONTACT_EMAIL}
  </a>
);

/** tuti.so's terms and privacy policy (a self-hosted server's operator writes their own). */
export function LegalPage({ title, updated, children }: { title: string; updated: string; children: React.ReactNode }) {
  return (
    <article className="flex flex-col gap-4 leading-relaxed [&_h2]:mt-6 [&_h2]:font-heading [&_h2]:text-xl [&_h2]:font-bold [&_li]:mt-1.5 [&_ul]:list-disc [&_ul]:pl-6">
      <header className="flex flex-col gap-2">
        <h1 className="font-heading text-3xl font-bold tracking-tight">{title}</h1>
        <p className="text-sm text-muted-foreground">Last updated {updated}</p>
      </header>
      {children}
    </article>
  );
}
