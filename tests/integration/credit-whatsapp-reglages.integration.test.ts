import '../../src/charger-env';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { pgSsl } from '../../src/db/ssl';
import { PgCreditWhatsappReglagesStore } from '../../src/credit-whatsapp/reglages.pg';
import type { TarifGrille } from '../../src/credit-whatsapp/grille';

/**
 * LES RÉGLAGES DU CRÉDIT WHATSAPP SUR UNE VRAIE BASE (migration 0264, plan du Crédit WhatsApp, tâche 2) : la grille en
 * vigueur est la dernière chargée dont la date est passée, une grille future attend sa date, la commission est un
 * singleton.
 *
 * ⚠️ Ne PAS le lancer en local : le `DATABASE_URL` du `.env` local pointe sur une base de production. La CI monte un
 * Postgres jetable pour ça (job `integration`).
 */
const url = process.env.DATABASE_URL ?? '';

const jour = (decalage: number): string => new Date(Date.now() + decalage * 86_400_000).toISOString().slice(0, 10);

const TARIFS: TarifGrille[] = [
  { marche: 'FR', categorie: 'marketing', palier: 0, prixMicroEur: 71200 },
  { marche: 'FR', categorie: 'utility', palier: 0, prixMicroEur: 24800 },
  { marche: 'other', categorie: 'marketing', palier: 0, prixMicroEur: 55800 },
];

describe.skipIf(!url)('les réglages du Crédit WhatsApp (0264)', () => {
  let pool: Pool;
  const grilles: string[] = [];

  beforeAll(() => {
    pool = new Pool({ connectionString: url, ssl: pgSsl(url) });
  });

  afterAll(async () => {
    if (grilles.length > 0) await pool.query('delete from grilles_meta where id = any($1::uuid[])', [grilles]);
    await pool.query('update credit_whatsapp_reglages set commission_pct = 5 where id');
    await pool.end();
  });

  it('la grille en vigueur est la dernière dont la date est passée ; une grille future attend', async () => {
    const store = new PgCreditWhatsappReglagesStore(pool);
    grilles.push(await store.chargerGrille({ enVigueurLe: jour(-40), tarifs: TARIFS, auteur: 'ops@exemple.fr', note: 'ancienne' }));
    const enVigueur = await store.chargerGrille({ enVigueurLe: jour(-1), tarifs: TARIFS.slice(0, 2), auteur: 'ops@exemple.fr', note: 'en vigueur' });
    grilles.push(enVigueur);
    grilles.push(await store.chargerGrille({ enVigueurLe: jour(20), tarifs: TARIFS, auteur: 'ops@exemple.fr', note: 'future' }));

    const g = await new PgCreditWhatsappReglagesStore(pool).grilleEnVigueur();
    expect(g?.id).toBe(enVigueur);
    expect(g?.tarifs).toHaveLength(2);
    expect(g?.tarifs.find((t) => t.categorie === 'marketing')?.prixMicroEur).toBe(71200);

    const r = await store.resumeGrille();
    expect(r).toMatchObject({ id: enVigueur, enVigueurLe: jour(-1), chargeePar: 'ops@exemple.fr', note: 'en vigueur', tarifs: 2 });
    expect(r?.prochaine).toEqual({ enVigueurLe: jour(20) });
  });

  it('🔴 un tarif refusé par la base n’enregistre aucune grille (une transaction)', async () => {
    const store = new PgCreditWhatsappReglagesStore(pool);
    const avant = (await pool.query<{ n: string }>('select count(*) as n from grilles_meta')).rows[0]!.n;
    await expect(store.chargerGrille({
      enVigueurLe: jour(-1), auteur: 'ops@exemple.fr', note: 'fausse',
      tarifs: [{ marche: 'FR', categorie: 'marketing', palier: 0, prixMicroEur: -1 }],
    })).rejects.toThrow();
    const apres = (await pool.query<{ n: string }>('select count(*) as n from grilles_meta')).rows[0]!.n;
    expect(apres).toBe(avant);
  });

  it('la commission : 5 % au départ, un singleton réglé et signé', async () => {
    const store = new PgCreditWhatsappReglagesStore(pool);
    expect(await store.commission()).toBe(5);
    await store.reglerCommission(7, 'ops@exemple.fr : essai');
    expect(await store.commission()).toBe(7);
    const { rows } = await pool.query<{ n: string; par: string }>('select count(*) over () as n, modifie_par as par from credit_whatsapp_reglages');
    expect(rows).toHaveLength(1);
    expect(rows[0]!.par).toBe('ops@exemple.fr : essai');
  });
});
