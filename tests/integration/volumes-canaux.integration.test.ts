import 'dotenv/config';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { pgSsl } from '../../src/db/ssl';
import { PgStatsStore } from '../../src/stats/store.pg';

// Ne PAS lancer ce fichier en local : le DATABASE_URL du .env local pointe sur la base de PRODUCTION
// (cf. CLAUDE.md du repo), et ce fichier cree/supprime des tenants. La CI monte un Postgres jetable pour ca.
const url = process.env.DATABASE_URL ?? '';

/**
 * LES VOLUMES PAR CANAL DES CARTES DE L'ACCUEIL (2026-09-25), sur un vrai Postgres.
 *
 * Chaque fixture est choisie pour qu'UNE clause qui saute change le total d'une façon reconnaissable :
 *  - le fil de TEST porte des messages sur les deux canaux (sans `not cv.is_test`, tout grossit) ;
 *  - l'AUTRE espace porte des messages sur les deux canaux (sans `cv.tenant_id = $1`, idem) ;
 *  - un message de chaque sens date de QUARANTE jours (sans la fenêtre, les deux sens grossissent) ;
 *  - un modèle sortant est présent (s'il était écarté, WhatsApp envoyés tomberait de 3 à 2).
 */
describe.skipIf(!url)('PgStatsStore.volumesParCanal (Postgres)', () => {
  let pool: Pool;
  let store: PgStatsStore;
  let tenantId: string;
  let autreTenantId: string;
  let tenantVide: string;

  beforeAll(async () => {
    pool = new Pool({ connectionString: url, ssl: pgSsl(), max: 2 });
    store = new PgStatsStore(pool);
    const espace = async (nom: string): Promise<string> =>
      (await pool.query<{ id: string }>(`insert into tenants (name) values ($1) returning id`, [nom])).rows[0]!.id;
    tenantId = await espace('itest-volumes-canaux');
    autreTenantId = await espace('itest-volumes-canaux-autre');
    tenantVide = await espace('itest-volumes-canaux-vide');

    const fil = async (tenant: string, waId: string, isTest: boolean): Promise<string> =>
      (await pool.query<{ id: string }>(
        `insert into conversations (tenant_id, wa_id, is_test) values ($1, $2, $3) returning id`,
        [tenant, waId, isTest],
      )).rows[0]!.id;
    const message = (conv: string, direction: 'in' | 'out', type: string, canal: 'whatsapp' | 'rcs', ilYA = '0 days') =>
      pool.query(
        `insert into conversation_messages (conversation_id, direction, type, body, channel, created_at)
         values ($1, $2, $3, 'x', $4, now() - $5::interval)`,
        [conv, direction, type, canal, ilYA],
      );

    // L'espace mesuré : WhatsApp 3 envoyés (dont un MODÈLE) et 2 reçus, RCS 1 envoyé et 1 reçu.
    const client = await fil(tenantId, '33650000501', false);
    await message(client, 'out', 'template', 'whatsapp');
    await message(client, 'out', 'text', 'whatsapp');
    await message(client, 'out', 'mba', 'whatsapp');
    await message(client, 'in', 'text', 'whatsapp');
    await message(client, 'in', 'reaction', 'whatsapp');
    await message(client, 'out', 'rcs', 'rcs');
    await message(client, 'in', 'text', 'rcs');
    // Hors fenêtre : un de chaque sens, sur chaque canal.
    await message(client, 'out', 'text', 'whatsapp', '40 days');
    await message(client, 'in', 'text', 'whatsapp', '40 days');
    await message(client, 'out', 'rcs', 'rcs', '40 days');
    await message(client, 'in', 'text', 'rcs', '40 days');

    // Un fil de TEST du même espace : rien n'en est compté.
    const essai = await fil(tenantId, '33650000502', true);
    await message(essai, 'out', 'text', 'whatsapp');
    await message(essai, 'in', 'text', 'rcs');

    // Un AUTRE espace : rien n'en est compté.
    const autre = await fil(autreTenantId, '33650000503', false);
    await message(autre, 'out', 'text', 'whatsapp');
    await message(autre, 'in', 'text', 'whatsapp');
    await message(autre, 'out', 'rcs', 'rcs');
  });

  afterAll(async () => {
    // Le cascade des tenants emporte conversations et messages.
    for (const id of [tenantId, autreTenantId, tenantVide]) {
      if (id) await pool.query('delete from tenants where id = $1', [id]);
    }
    await pool.end();
  });

  it('🔴 compte par canal et par sens, modèles compris, hors fils de test, hors autre espace, sur la fenêtre', async () => {
    expect(await store.volumesParCanal(tenantId, 30)).toEqual({
      whatsapp: { envoyes: 3, recus: 2 },
      rcs: { envoyes: 1, recus: 1 },
    });
  });

  it('l autre espace ne voit que les siens', async () => {
    expect(await store.volumesParCanal(autreTenantId, 30)).toEqual({
      whatsapp: { envoyes: 1, recus: 1 },
      rcs: { envoyes: 1, recus: 0 },
    });
  });

  it('un espace sans message rend des zéros MESURÉS, sur les deux canaux', async () => {
    expect(await store.volumesParCanal(tenantVide, 30)).toEqual({
      whatsapp: { envoyes: 0, recus: 0 },
      rcs: { envoyes: 0, recus: 0 },
    });
  });
});
