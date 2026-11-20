import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** A config file (TUTI_CONFIG) holding `values`, in a new directory: its path, e.g. for `vi.stubEnv("TUTI_CONFIG", …)`. */
export function configFile(values: unknown): string {
  const path = join(mkdtempSync(join(tmpdir(), "tuti-config-")), "tuti.json");
  writeFileSync(path, JSON.stringify(values));
  return path;
}

/** A config file with AI credits on, and any other credits values: e.g. `vi.stubEnv("TUTI_CONFIG", creditsOn({ low: 50 }))`. */
export const creditsOn = (credits: Record<string, unknown> = {}) => configFile({ credits: { enabled: true, ...credits } });
