import '../../src/charger-env';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { pgSsl } from '../../src/db/ssl';
import { PgCreditWhatsappStore } from '../../src/credit-whatsapp/credit.pg';

/**
 * LE MAGASIN DU CRÉDIT WHATSAPP SUR UNE VRAIE BASE (migration 0264, plan du Crédit WhatsApp, tâche 3).
 *
 * 🔴 CE QU'AUCUN TEST UNITAIRE NE VOIT : le débit conditionnel sous concurrence, l'idempotence par paiement, et
 * l'invariant « solde = mouvements − provisions non rendues » après n'importe quelle suite d'écritures.
 *
 * ⚠️ Ne PAS le lancer en local : le `DATABASE_URL` du `.env` local pointe sur une base de production. La CI monte un
 * Postgres jetable pour ça (job `integration`).
 */
const url = process.env.DATABASE_URL ?? '';
const NUMERO = 'pn-credit-wa-test';

describe.skipIf(!url)('le Crédit WhatsApp (0264)', () => {
  let pool: Pool;
  let store: PgCreditWhatsappStore;
  const espaces: string[] = [];

  async function espace(): Promise<string> {
    const id = (await pool.query<{ id: string }>(`insert into tenants (name) values ('credit-wa-test') returning id`)).rows[0]!.id;
    espaces.push(id);
    return id;
  }

  /** L'invariant : le solde stocké égale le solde recalculé depuis les lignes. */
  async function invariant(tenantId: string): Promise<void> {
    const { rows } = await pool.query<{ stocke: string | null; recalcule: string }>(
      `select (select solde_micro_eur from credits_whatsapp where tenant_id = $1) as stocke,
              (select coalesce(sum(delta_micro_eur), 0) from credit_whatsapp_mouvements where tenant_id = $1)
            - (select coalesce(sum(montant_micro_eur), 0) from credit_whatsapp_provisions where tenant_id = $1 and etat <> 'rendu') as recalcule`,
      [tenantId],
    );
    expect(Number(rows[0]!.stocke ?? 0)).toBe(Number(rows[0]!.recalcule));
  }

  const provision = (tenantId: string, montant: number, openBar = false, categorie: 'marketing' | 'service' = 'marketing') =>
    store.provisionner({ tenantId, phoneNumberId: NUMERO, pays: 'FR', categorie, montantMicroEur: montant, openBar });

  beforeAll(() => {
    pool = new Pool({ connectionString: url, ssl: pgSsl(url) });
    store = new PgCreditWhatsappStore(pool);
  });

  afterAll(async () => {
    if (espaces.length > 0) await pool.query('delete from tenants where id = any($1::uuid[])', [espaces]);
    await pool.end();
  });

  it('🔴 deux envois simultanés sur un solde qui n’en couvre qu’un : un seul passe', async () => {
    const t = await espace();
    await store.crediter(t, 100_000, 'achat', 'cs_concurrence');
    const issues = await Promise.all([provision(t, 74_760), provision(t, 74_760)]);
    expect(issues.filter((i) => i.ok)).toHaveLength(1);
    expect(issues.find((i) => !i.ok)).toEqual({ ok: false, soldeMicroEur: 25_240 });
    await invariant(t);
  });

  it('🔴 un espace jamais crédité est refusé, solde zéro, même pour un message à zéro (tout s’arrête à zéro)', async () => {
    const t = await espace();
    expect(await provision(t, 1)).toEqual({ ok: false, soldeMicroEur: 0 });
    expect(await provision(t, 0, false, 'service')).toEqual({ ok: false, soldeMicroEur: 0 });
    // Un micro-euro suffit à laisser partir un message de la franchise, sans le débiter.
    await store.crediter(t, 1, 'achat', 'cs_un_micro');
    expect(await provision(t, 0, false, 'service')).toMatchObject({ ok: true });
    expect(await store.solde(t)).toBe(1);
    await invariant(t);
  });

  it('🔴 un paiement ne crédite qu’une fois, même rejoué', async () => {
    const t = await espace();
    expect(await store.crediter(t, 50_000_000, 'achat', 'cs_un')).toEqual({ applique: true, soldeMicroEur: 50_000_000 });
    expect(await store.crediter(t, 50_000_000, 'achat', 'cs_un')).toEqual({ applique: false, soldeMicroEur: 50_000_000 });
    await invariant(t);
  });

  it('une provision rendue deux fois ne rend qu’une fois ; un wamid se rattache une fois', async () => {
    const t = await espace();
    await store.crediter(t, 200_000, 'achat', 'cs_rendu');
    const p = await provision(t, 74_760);
    if (!p.ok) throw new Error('provision refusée');
    await store.rattacher(p.provisionId, 'wamid.A');
    await store.rattacher(p.provisionId, 'wamid.B');
    await store.rendreParWamid(t, 'wamid.A');
    await store.rendreParWamid(t, 'wamid.A');
    await store.rendre(p.provisionId);
    expect(await store.solde(t)).toBe(200_000);
    await invariant(t);
  });

  it('une catégorie reclassée corrige la provision une seule fois, et le solde de la différence', async () => {
    const t = await espace();
    await store.crediter(t, 200_000, 'achat', 'cs_corrige');
    const p = await provision(t, 26_040);
    if (!p.ok) throw new Error('provision refusée');
    await store.rattacher(p.provisionId, 'wamid.C');
    await store.corrigerParWamid(t, 'wamid.C', 'marketing', 74_760);
    await store.corrigerParWamid(t, 'wamid.C', 'marketing', 99_999);
    expect(await store.solde(t)).toBe(200_000 - 74_760);
    await store.rendreParWamid(t, 'wamid.C');
    expect(await store.solde(t)).toBe(200_000);
    await invariant(t);
  });

  it('la provision d’un message se lit par son wamid, dans son espace seulement (ajustement à l’accusé, tâche 7)', async () => {
    const t = await espace();
    const autre = await espace();
    const p = await provision(t, 0, true, 'service');
    if (!p.ok) throw new Error('provision refusée');
    await store.rattacher(p.provisionId, 'wamid.L');
    expect(await store.provisionDuWamid(t, 'wamid.L')).toEqual({ categorie: 'service', pays: 'FR', montantMicroEur: 0, etat: 'provisionne' });
    expect(await store.provisionDuWamid(autre, 'wamid.L')).toBeNull();
    expect(await store.provisionDuWamid(t, 'wamid.inconnu')).toBeNull();
    await store.marquerLivre(t, 'wamid.L', new Date('2026-10-30T10:00:00Z'));
    await store.marquerLivre(t, 'wamid.L', new Date('2026-10-30T11:00:00Z'));
    const { rows } = await pool.query<{ livre_le: Date }>('select livre_le from credit_whatsapp_provisions where id = $1', [p.provisionId]);
    expect(rows[0]!.livre_le.toISOString()).toBe('2026-10-30T10:00:00.000Z');
  });

  it('les dernières provisions d’un espace pour /ops : les plus récentes d’abord, bornées, dans son espace seulement', async () => {
    const t = await espace();
    const autre = await espace();
    for (const montant of [1_000, 2_000, 3_000]) {
      const p = await provision(t, montant, true);
      if (!p.ok) throw new Error('provision refusée');
    }
    await provision(autre, 9_000, true);
    const vues = await store.dernieresProvisions(t, 2);
    expect(vues.map((v) => v.montantMicroEur)).toEqual([3_000, 2_000]);
    expect(vues[0]).toMatchObject({ phoneNumberId: NUMERO, pays: 'FR', categorie: 'marketing', etat: 'provisionne', wamid: null, livreLe: null });
    expect((await store.dernieresProvisions(t)).every((v) => v.montantMicroEur !== 9_000)).toBe(true);
  });

  it('l’open bar provisionne sans regarder le solde, et le compte', async () => {
    const t = await espace();
    expect(await provision(t, 74_760, true)).toMatchObject({ ok: true });
    expect(await store.solde(t)).toBe(-74_760);
    await invariant(t);
  });

  it('une régularisation du jour se remplace : le solde ne bouge que de la dernière valeur', async () => {
    const t = await espace();
    await store.crediter(t, 1_000_000, 'achat', 'cs_regul');
    await store.regulariser(t, '2026-10-29', -30_000);
    await store.regulariser(t, '2026-10-29', -10_000);
    await store.regulariser(t, '2026-10-30', 5_000);
    expect(await store.solde(t)).toBe(1_000_000 - 10_000 + 5_000);
    const lignes = (await pool.query(`select 1 from credit_whatsapp_mouvements where tenant_id = $1 and raison = 'regularisation'`, [t])).rowCount;
    expect(lignes).toBe(2);
    await invariant(t);
  });

  it('la franchise compte les services du numéro dans le mois, sans les rendus, jusqu’au plafond', async () => {
    const t = await espace();
    await store.crediter(t, 1_000_000, 'achat', 'cs_franchise');
    for (let i = 0; i < 3; i++) await provision(t, 0, false, 'service');
    const rendu = await provision(t, 0, false, 'service');
    if (rendu.ok) await store.rendre(rendu.provisionId);
    await provision(t, 74_760);
    const mois = new Date().toISOString().slice(0, 7);
    expect(await store.serviceDuMois(NUMERO, mois, 1000)).toBeGreaterThanOrEqual(3);
    expect(await store.serviceDuMois(NUMERO, mois, 2)).toBe(2);
    expect(await store.serviceDuMois(NUMERO, '2020-01', 1000)).toBe(0);
  });

  it('l’historique : les envois en une ligne par jour, les achats à part, aucune note', async () => {
    const t = await espace();
    await store.crediter(t, 1_000_000, 'achat', 'cs_histo', 'note interne de Julien');
    await provision(t, 74_760);
    await provision(t, 26_040);
    const h = await store.historique(t);
    const envois = h.filter((l) => l.raison === 'envois');
    expect(envois).toHaveLength(1);
    expect(envois[0]).toMatchObject({ deltaMicroEur: -(74_760 + 26_040), messages: 2 });
    expect(h.find((l) => l.raison === 'achat')).toMatchObject({ deltaMicroEur: 1_000_000, reference: 'cs_histo' });
    expect(JSON.stringify(h)).not.toContain('note interne');
  });
});
