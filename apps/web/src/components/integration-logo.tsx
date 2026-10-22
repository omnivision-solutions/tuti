/** A tool's logo on Settings → Integrations, in a white tile like the tools' own app icons. */
export function IntegrationLogo({ children }: { children: React.ReactNode }) {
  return <span className="flex size-11 shrink-0 items-center justify-center rounded-lg border bg-white text-black">{children}</span>;
}
