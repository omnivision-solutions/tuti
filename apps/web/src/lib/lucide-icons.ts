import dynamicIconImports from "lucide-react/dynamicIconImports";

/**
 * Lucide's icon `name` (kebab-case, as on lucide.dev; aliases too) loads its drawing on demand;
 * undefined for a name the installed Lucide doesn't have (a collection's icon it dropped since).
 */
export const lucideIcon = (name: string | null | undefined) =>
  name && Object.hasOwn(dynamicIconImports, name) ? dynamicIconImports[name as keyof typeof dynamicIconImports] : undefined;
