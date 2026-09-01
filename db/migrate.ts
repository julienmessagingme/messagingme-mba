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
import { pgSsl } from '../src/db/ssl';
import { veutHorsTransaction, decouperInstructions } from '../src/db/migration-directives';

const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(here, 'migrations');

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL manquant (.env)');

  const client = new Client({
    connectionString: url,
    ssl: pgSsl(),
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
    const horsTransaction = veutHorsTransaction(sql);
    process.stdout.write(`-> ${file}${horsTransaction ? ' (hors transaction)' : ''} ... `);
    try {
      if (horsTransaction) {
        // 🔴 AUCUN filet ici, et c'est le prix à payer pour `CREATE INDEX CONCURRENTLY`, que Postgres refuse
        // dans un bloc de transaction. Une migration hors transaction qui échoue à mi-parcours laisse la base
        // dans son état intermédiaire ET n'est pas enregistrée : le prochain `migrate` la REJOUE depuis le
        // début. Elle doit donc être écrite idempotente, instruction par instruction (`if not exists`), ce
        // qu'un `CREATE INDEX CONCURRENTLY IF NOT EXISTS` est. Ce n'est pas une recommandation : c'est la
        // condition pour employer cette directive.
        //
        // 🔴 UNE INSTRUCTION PAR REQUÊTE, sans quoi la directive ne servirait à rien : Postgres exécute une
        // requête simple multi-instructions dans une transaction IMPLICITE, et `CONCURRENTLY` y redeviendrait
        // illégal. Mesuré, cf. `decouperInstructions`.
        for (const instruction of decouperInstructions(sql)) await client.query(instruction);
        await client.query('insert into schema_migrations(name) values ($1)', [file]);
      } else {
        await client.query('begin');
        await client.query(sql);
        await client.query('insert into schema_migrations(name) values ($1)', [file]);
        await client.query('commit');
      }
      count++;
      process.stdout.write('ok\n');
    } catch (err) {
      if (horsTransaction) {
        process.stdout.write('ECHEC\n');
        // Un `CREATE INDEX CONCURRENTLY` interrompu laisse derrière lui un index INVALIDE, que Postgres
        // n'utilisera jamais et que `if not exists` considère pourtant comme présent : la migration rejouée
        // le sauterait, et l'index resterait mort sans que rien ne le dise. On nomme le geste ici, au moment
        // où quelqu'un lit l'erreur, plutôt que dans un document qu'il faudrait penser à ouvrir.
        console.error(
          `\n⚠️ ${file} tournait HORS transaction : rien n'a été annulé.\n` +
          "   Vérifier les index invalides avant de relancer :\n" +
          "   select i.indexrelid::regclass from pg_index i where not i.indisvalid;\n" +
          '   Puis `drop index <nom>;` pour chacun, sinon `if not exists` les laissera morts.\n',
        );
      } else {
        await client.query('rollback');
      }
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
