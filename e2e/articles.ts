import pg from "pg";

/** `published` published docs articles in the project, and a draft, "One too many" (journeys have no faster way to). */
export async function seedArticles(slug: string, published: number) {
  const client = new pg.Client({ connectionString: process.env.E2E_DATABASE_URL });
  await client.connect();
  try {
    await client.query(
      `INSERT INTO article (id, "projectId", slug, title, "publishedAt", "updatedAt")
       SELECT gen_random_uuid()::text, project.id, 'seeded-' || n, 'Seeded ' || n, now(), now() FROM project, generate_series(1, $2) AS n WHERE project.slug = $1
       UNION ALL SELECT gen_random_uuid()::text, project.id, 'one-too-many', 'One too many', NULL, now() FROM project WHERE project.slug = $1`,
      [slug, published],
    );
  } finally {
    await client.end();
  }
}
