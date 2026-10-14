/**
 * L'EXERCICE DE RESTAURATION, SECOND TEMPS : la copie restaurée se relit, et ses secrets se DÉCHIFFRENT (lot 2 du bilan
 * des audits). Une sauvegarde de la base sans la clé ne restaure rien : les jetons de Meta, les mots de passe SMTP, les
 * secrets Salesforce resteraient illisibles. Ce script le prouve ou le dément, sur la copie seule.
 *
 * 🔴 IL NE TOUCHE JAMAIS LA PRODUCTION : il ne lit que `EXERCICE_URL` (le Postgres jetable de l'exercice) et refuse de
 * démarrer si l'adresse ne désigne pas une base locale nommée « exercice ». Il n'affiche AUCUNE valeur : des comptes.
 *
 * Les colonnes chiffrées se trouvent par leur nom (`_enc`, `_chiffre`, `_chiffree`), pas par une liste écrite ici : une
 * liste dériverait au premier secret ajouté.
 *
 * Usage (dans l'image de l'API) : EXERCICE_URL=postgres://...@127.0.0.1:55432/exercice ENCRYPTION_KEY=... \
 *   npx tsx scripts/exercice-dechiffrer.ts
 */
import pg from 'pg';
import { decryptSecret } from '../src/crypto/secretbox';

const url = process.env.EXERCICE_URL ?? '';
const cle = process.env.ENCRYPTION_KEY ?? '';
const cible = URL.canParse(url) ? new URL(url) : null;
if (!cible || !['127.0.0.1', 'localhost'].includes(cible.hostname) || cible.pathname !== '/exercice') {
  console.error('EXERCICE_URL doit désigner la base locale « exercice » du Postgres jetable, jamais la production.');
  process.exit(2);
}
if (!/^[0-9a-f]{64}$/i.test(cle)) {
  console.error('ENCRYPTION_KEY absente ou mal formée (64 caractères hexadécimaux attendus).');
  process.exit(2);
}

const TABLES_CLES = ['tenants', 'users', 'contacts', 'conversations', 'conversation_messages', 'campaigns', 'workflows', 'agents', 'waba_credentials'];

const c = new pg.Client({ connectionString: url });
await c.connect();
let echecs = 0;
try {
  const derniere = await c.query<{ name: string | null }>('select max(name) as name from public.schema_migrations');
  console.log(`derniere migration ${derniere.rows[0]?.name ?? 'aucune'}`);
  for (const t of TABLES_CLES) {
    const n = await c.query<{ n: number }>(`select count(*)::int as n from public.${t}`).catch(() => null);
    console.log(`table ${t} ${n ? n.rows[0]!.n : 'absente'}`);
  }
  const colonnes = await c.query<{ s: string; t: string; c: string }>(
    `select table_schema as s, table_name as t, column_name as c from information_schema.columns
      where table_schema in ('public', 'salesforce') and data_type = 'text'
        and (column_name like '%\\_enc' or column_name like '%\\_chiffre' or column_name like '%\\_chiffree')
      order by 1, 2, 3`);
  for (const col of colonnes.rows) {
    const valeurs = await c.query<{ v: string }>(`select "${col.c}" as v from "${col.s}"."${col.t}" where "${col.c}" is not null`);
    let ok = 0;
    for (const { v } of valeurs.rows) {
      try {
        decryptSecret(v, cle);
        ok += 1;
      } catch {
        echecs += 1;
      }
    }
    console.log(`secret ${col.s}.${col.t}.${col.c} ${ok}/${valeurs.rows.length} dechiffres`);
  }
} finally {
  await c.end();
}
console.log(echecs === 0 ? 'DECHIFFREMENT OK' : `DECHIFFREMENT ECHOUE : ${echecs} secret(s) illisible(s)`);
process.exit(echecs === 0 ? 0 : 1);
