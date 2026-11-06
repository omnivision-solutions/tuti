import { FEATUREBASE_ICONS } from "@tuti/jobs";
import { expect, test } from "vitest";

import { lucideIcon } from "./lucide-icons";

test("every Featurebase icon an import maps is one the installed Lucide has", () => {
  expect(Object.values(FEATUREBASE_ICONS).filter((name) => !lucideIcon(name))).toEqual([]);
});
