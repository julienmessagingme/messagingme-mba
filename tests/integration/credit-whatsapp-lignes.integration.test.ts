import '../../src/charger-env';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { pgSsl } from '../../src/db/ssl';
import { PgLignesCreditStore } from '../../src/credit-whatsapp/lignes.pg';

/**
 * LES NUMÉROS SUR LA LIGNE DU CRÉDIT WHATSAPP SUR UNE VRAIE BASE (migration 0264, tâches 4 et 8).
 *
 * 🔴 CE QU'AUCUN TEST UNITAIRE NE VOIT : le `on conflict` de la pose contre l'index partiel (un prédicat qui diverge
 * échoue à chaque pose, en production), une ligne retirée qui libère le numéro pour une nouvelle, et la lecture du numéro
 * DANS son espace, avec son fournisseur et sa coexistence.
 *
 * ⚠️ Ne PAS le lancer en local : le `DATABASE_URL` du `.env` local pointe sur une base de production. La CI monte un
 * Postgres jetable pour ça (job `integration`).
 */
const url = process.env.DATABASE_URL ?? '';

describe.skipIf(!url)('les numéros sur la ligne du Crédit WhatsApp (0264)', () => {
  let pool: Pool;
  let lignes: PgLignesCreditStore;
  const espaces: string[] = [];

  async function espace(): Promise<string> {
    const id = (await pool.query<{ id: string }>(`insert into tenants (name) values ('credit-wa-lignes') returning id`)).rows[0]!.id;
    espaces.push(id);
    return id;
  }

  /** Un numéro de l'espace sur son compte WhatsApp ; `fournisseur` absent = sans compte propre (notre portefeuille). */
  async function numero(tenantId: string, id: string, o: { fournisseur?: 'meta' | '360dialog'; coexistence?: boolean; delie?: boolean } = {}): Promise<void> {
    const waba = `waba-${id}`;
    await pool.query(`insert into waba (id, tenant_id, name) values ($1, $2, 'itest')`, [waba, tenantId]);
    if (o.fournisseur !== undefined) {
      await pool.query(`insert into waba_credentials (waba_id, tenant_id, business_token_enc, fournisseur) values ($1, $2, 'x', $3)`, [waba, tenantId, o.fournisseur]);
    }
    await pool.query(
      `insert into phone_numbers (id, tenant_id, waba_id, display_phone_number, coexistence, delie_le)
       values ($1, $2, $3, '+33 6 00 00 00 00', $4, case when $5 then now() end)`,
      [id, tenantId, waba, o.coexistence ?? false, o.delie ?? false],
    );
  }

  beforeAll(() => {
    pool = new Pool({ connectionString: url, ssl: pgSsl(url) });
    lignes = new PgLignesCreditStore(pool);
  });

  afterAll(async () => {
    if (espaces.length > 0) await pool.query('delete from tenants where id = any($1::uuid[])', [espaces]);
    await pool.end();
  });

  it('🔴 une ligne en cours par numéro : la seconde pose est refusée sans erreur, une ligne retirée libère le numéro', async () => {
    const t = await espace();
    await numero(t, 'itest-cwa-1');
    expect(await lignes.poser(t, 'itest-cwa-1', 'waba-itest-cwa-1', 'ops', 'essai')).toBe(true);
    expect(await lignes.poser(t, 'itest-cwa-1', 'waba-itest-cwa-1', 'ops', 'encore')).toBe(false);
    expect(await lignes.ligneDuNumero('itest-cwa-1')).toMatchObject({ tenantId: t, origine: 'ops', arreteeLe: null });
    expect(await lignes.arreter(t, 'itest-cwa-1')).toBe(true);
    expect((await lignes.ligneDuNumero('itest-cwa-1'))?.arreteeLe).not.toBeNull();
    expect(await lignes.retirer(t, 'itest-cwa-1')).toBe(true);
    expect(await lignes.ligneDuNumero('itest-cwa-1')).toBeNull();
    expect(await lignes.retirer(t, 'itest-cwa-1')).toBe(false);
    expect(await lignes.poser(t, 'itest-cwa-1', 'waba-itest-cwa-1', 'ops', 'nouvel essai')).toBe(true);
    expect(await lignes.lignesDeLEspace(t)).toHaveLength(1);
  });

  it('🔴 un numéro se lit dans SON espace seulement, avec son fournisseur, sa coexistence et son état délié', async () => {
    const t = await espace();
    const autre = await espace();
    await numero(t, 'itest-cwa-meta');
    await numero(t, 'itest-cwa-360', { fournisseur: '360dialog' });
    await numero(t, 'itest-cwa-coex', { fournisseur: 'meta', coexistence: true, delie: true });
    expect(await lignes.numeroDeLEspace(t, 'itest-cwa-meta')).toEqual({ wabaId: 'waba-itest-cwa-meta', fournisseur: 'meta', coexistence: false, delie: false });
    expect(await lignes.numeroDeLEspace(t, 'itest-cwa-360')).toMatchObject({ fournisseur: '360dialog' });
    expect(await lignes.numeroDeLEspace(t, 'itest-cwa-coex')).toMatchObject({ fournisseur: 'meta', coexistence: true, delie: true });
    expect(await lignes.numeroDeLEspace(autre, 'itest-cwa-meta')).toBeNull();
    expect(await lignes.numeroDeLEspace(t, 'itest-cwa-inconnu')).toBeNull();
  });
});
