/**
 * `npm run migrations` : le dernier numéro PRIS (le dossier), le prochain libre, le dernier APPLIQUÉ (la base) et ce
 * qui attend. Calcul : `src/db/migrations-etat.ts`.
 *
 * 🔴 LECTURE SEULE, sur un client DÉDIÉ : `begin read only` puis `rollback`, jamais un `SET` de session (le pooler
 * prête sa connexion, un réglage de session y survivrait). Le `DATABASE_URL` d'un poste pointe sur la production.
 */
import '../src/charger-env';
import { readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from 'pg';
import { pgSsl } from '../src/db/ssl';
import { etatMigrations } from '../src/db/migrations-etat';

const dossier = join(dirname(fileURLToPath(import.meta.url)), 'migrations');
const fichiers = readdirSync(dossier);

async function lireBase(url: string): Promise<string[]> {
  const c = new Client({ connectionString: url, ssl: pgSsl() });
  await c.connect();
  try {
    await c.query('begin read only');
    // `public.` : plusieurs schémas de cette base portent une table de ce nom.
    return (await c.query<{ name: string }>('select name from public.schema_migrations')).rows.map((r) => r.name);
  } finally {
    await c.query('rollback').catch(() => undefined);
    await c.end();
  }
}

const url = process.env.DATABASE_URL;
const e = etatMigrations(fichiers, url ? await lireBase(url) : null);
console.log(`dossier : dernier pris ${e.dernierPris ?? '(aucun)'}, prochain libre ${e.prochainLibre}`);
if (e.dernierApplique === null) {
  console.log('base : non lue (DATABASE_URL absent)');
} else {
  console.log(`base : dernière appliquée ${e.dernierApplique}`);
  console.log(`en attente : ${e.enAttente.length ? e.enAttente.join(', ') : 'aucune'}`);
  console.log(`appliquées sans fichier : ${e.sansFichier.length ? e.sansFichier.join(', ') : 'aucune'}`);
}
