/**
 * Runner de migrations minimal : applique en ordre les fichiers db/migrations/*.sql
 * pas encore appliqués, en les suivant dans une table schema_migrations.
 * Usage : npx tsx db/migrate.ts
 */
import 'dotenv/config';
import { readdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from 'pg';

const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(here, 'migrations');

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL manquant (.env)');

  const client = new Client({
    connectionString: url,
    ssl: { rejectUnauthorized: false },
  });
  await client.connect();

  await client.query(`
    create table if not exists schema_migrations (
      name text primary key,
      applied_at timestamptz not null default now()
    )
  `);

  const applied = new Set<string>(
    (await client.query('select name from schema_migrations')).rows.map((r) => r.name as string),
  );

  const files = readdirSync(migrationsDir)
    .filter((f) => f.endsWith('.sql'))
    .sort();

  let count = 0;
  for (const file of files) {
    if (applied.has(file)) continue;
    const sql = readFileSync(join(migrationsDir, file), 'utf8');
    process.stdout.write(`-> ${file} ... `);
    try {
      await client.query('begin');
      await client.query(sql);
      await client.query('insert into schema_migrations(name) values ($1)', [file]);
      await client.query('commit');
      count++;
      process.stdout.write('ok\n');
    } catch (err) {
      await client.query('rollback');
      throw err;
    }
  }

  await client.end();
  console.log(count === 0 ? 'à jour, rien à appliquer' : `${count} migration(s) appliquée(s)`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
