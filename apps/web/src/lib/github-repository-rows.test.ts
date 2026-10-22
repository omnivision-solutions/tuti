import { expect, test } from "vitest";

import { repositoryRows } from "./github-repository-rows";

test("rows name the project that holds a repository on the same installation; one held from another stays switchable", () => {
  const rows = repositoryRows(
    [
      { id: 3, fullName: "acme/web" },
      { id: 1, fullName: "acme/api" },
      { id: 2, fullName: "acme/moved" },
    ],
    [3],
    [
      { repoId: 1, installationId: 10, project: "Acme Mobile" },
      { repoId: 2, installationId: 99, project: "another project" },
    ],
    10,
  );
  expect(rows).toEqual([
    { id: 1, fullName: "acme/api", included: false, elsewhere: "Acme Mobile" },
    { id: 2, fullName: "acme/moved", included: false, elsewhere: null },
    { id: 3, fullName: "acme/web", included: true, elsewhere: null },
  ]);
});
