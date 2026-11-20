import { AsyncLocalStorage } from "node:async_hooks";

import { config } from "./config";
import type { CodeChangesSettings } from "./config/autopilot";

export { CODE_CHANGES_SETTINGS, type CodeChangesSettings, settingLeaf } from "./config/autopilot";

/** The server's settings: its config file's `autopilot` section. */
export function serverCodeChangesSettings(): CodeChangesSettings {
  return config().autopilot;
}

const analysing = new AsyncLocalStorage<CodeChangesSettings>();

/**
 * The settings in use: inside withCodeChangesSettings (a project's analysis, with its Advanced tuning), those; else the
 * server's. So every step of an analysis reads the project's values without each one being handed them.
 */
export function codeChangesSettings(): CodeChangesSettings {
  return analysing.getStore() ?? serverCodeChangesSettings();
}

/** Runs `fn` (and everything it starts) with `settings` as codeChangesSettings(). */
export function withCodeChangesSettings<T>(settings: CodeChangesSettings, fn: () => T): T {
  return analysing.run(settings, fn);
}
