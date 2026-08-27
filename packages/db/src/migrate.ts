import { readdir, readFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";

const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(here, "..", "migrations");

const sql = postgres(process.env.DATABASE_URL ?? "", { max: 1 });

await sql`
  CREATE TABLE IF NOT EXISTS _migrations (
    name text PRIMARY KEY,
    applied_at timestamptz NOT NULL DEFAULT now()
  )
`;

const applied = new Set(
  (await sql<{ name: string }[]>`SELECT name FROM _migrations`).map((r) => r.name),
);

const files = (await readdir(migrationsDir)).filter((f) => f.endsWith(".sql")).sort();

for (const file of files) {
  if (applied.has(file)) {
    console.log(`skip  ${file}`);
    continue;
  }
  const body = await readFile(join(migrationsDir, file), "utf8");

  // `ALTER TYPE ... ADD VALUE` cannot run inside a transaction block on every
  // supported Postgres, so those migrations are applied unwrapped. They are
  // idempotent (IF NOT EXISTS), which is what makes that safe.
  const transactional = !/ALTER\s+TYPE\s+\S+\s+ADD\s+VALUE/i.test(body);

  if (transactional) {
    await sql.begin(async (tx) => {
      await tx.unsafe(body);
      await tx`INSERT INTO _migrations (name) VALUES (${file})`;
    });
  } else {
    await sql.unsafe(body);
    await sql`INSERT INTO _migrations (name) VALUES (${file})`;
  }
  console.log(`apply ${file}`);
}

await sql.end();
console.log("migrations complete");
