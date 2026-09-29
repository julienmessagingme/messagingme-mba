import '../../src/charger-env';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { pgSsl } from '../../src/db/ssl';
import { PgStripeStore, type PaiementStripe } from '../../src/stripe/store.pg';
import { PgCreditStore } from '../../src/agent/credits.pg';

/**
 * LA RECHARGE STRIPE EN BASE (migration 0191).
 *
 * 🔴 CE QU'AUCUN TEST UNITAIRE NE VOIT : qu'un paiement livré deux fois, ou dix fois EN MÊME TEMPS, ne crédite qu'une
 * fois. C'est la clé primaire de `stripe_paiements` qui tranche (la seconde insertion attend la première, puis tombe
 * en conflit), pas notre code : le faux dépôt le simule, il ne le prouve pas. DEUX POOLS, pour imiter deux copies de
 * l'API qui reçoivent chacune une livraison.
 *
 * ⚠️ Jamais joué en local (le `DATABASE_URL` local pointe la PRODUCTION), joué par le job `integration`.
 */
const url = process.env.DATABASE_URL ?? '';

describe.skipIf(!url)('la recharge Stripe, en base', () => {
  let poolA: Pool;
  let poolB: Pool;
  let tenantId: string;
  let autre: string;

  beforeAll(async () => {
    poolA = new Pool({ connectionString: url, ssl: pgSsl(), max: 8 });
    poolB = new Pool({ connectionString: url, ssl: pgSsl(), max: 8 });
    tenantId = (await poolA.query<{ id: string }>(`insert into tenants (name) values ('itest-stripe') returning id`)).rows[0]!.id;
    autre = (await poolA.query<{ id: string }>(`insert into tenants (name) values ('itest-stripe-autre') returning id`)).rows[0]!.id;
  });

  afterAll(async () => {
    // La cascade emporte clients, paiements, solde et mouvements.
    await poolA.query('delete from tenants where id = any($1::uuid[])', [[tenantId, autre].filter(Boolean)]);
    await poolA.end();
    await poolB.end();
  });

  const paiement = (over: Partial<PaiementStripe> = {}): PaiementStripe => ({
    sessionId: `cs_itest_${randomUUID()}`, tenantId, offre: 'refill_50', creditMicroEur: 50_000_000,
    htCentimes: 5_000, ttcCentimes: 6_000, factureId: null, livemode: false, ...over,
  });

  it('🔴 un paiement livré DEUX fois ne crédite qu’une fois, avec UNE ligne `achat`', async () => {
    const store = new PgStripeStore(poolA);
    const credits = new PgCreditStore(poolA);
    const avant = await credits.solde(tenantId);
    const p = paiement();
    expect(await store.crediterPaiement(p)).toBe('credite');
    expect(await store.crediterPaiement(p)).toBe('deja');
    expect(await credits.solde(tenantId)).toBe(avant + 50_000_000);
    const achats = (await credits.mouvements(tenantId, 50)).filter((m) => m.raison === 'achat');
    expect(achats).toHaveLength(1);
    expect(achats[0]!.deltaMicroEur).toBe(50_000_000);
    expect(achats[0]!.note).toContain(p.sessionId);
  });

  it('🔴 DIX livraisons SIMULTANÉES, sur deux copies, créditent une seule fois', async () => {
    const a = new PgStripeStore(poolA);
    const b = new PgStripeStore(poolB);
    const credits = new PgCreditStore(poolA);
    const avant = await credits.solde(tenantId);
    const p = paiement({ offre: 'refill_100', creditMicroEur: 100_000_000, htCentimes: 10_000 });
    const issues = await Promise.all(Array.from({ length: 10 }, (_, i) => (i % 2 === 0 ? a : b).crediterPaiement(p)));
    expect(issues.filter((x) => x === 'credite')).toHaveLength(1);
    expect(issues.filter((x) => x === 'deja')).toHaveLength(9);
    expect(await credits.solde(tenantId)).toBe(avant + 100_000_000);
  });

  it('la ligne de paiement garde ce que Stripe a encaissé, HT et TTC', async () => {
    const p = paiement({ factureId: 'in_itest', livemode: true });
    await new PgStripeStore(poolA).crediterPaiement(p);
    const r = await poolA.query(
      `select tenant_id, offre, credit_micro_eur::text, montant_ht_centimes, montant_ttc_centimes, facture_id, livemode
         from stripe_paiements where session_id = $1`,
      [p.sessionId],
    );
    expect(r.rows[0]).toEqual({
      tenant_id: tenantId, offre: 'refill_50', credit_micro_eur: '50000000',
      montant_ht_centimes: 5_000, montant_ttc_centimes: 6_000, facture_id: 'in_itest', livemode: true,
    });
  });

  it('un espace qui n’existe pas : `espace_inconnu`, et rien n’est écrit', async () => {
    const p = paiement({ tenantId: randomUUID() });
    expect(await new PgStripeStore(poolA).crediterPaiement(p)).toBe('espace_inconnu');
    const r = await poolA.query('select 1 from stripe_paiements where session_id = $1', [p.sessionId]);
    expect(r.rowCount).toBe(0);
  });

  it('🔴 le client Stripe est gardé PAR MODE, et le premier écrit fait autorité', async () => {
    const store = new PgStripeStore(poolA);
    const suffixe = randomUUID().slice(0, 8);
    expect(await store.clientDe(tenantId, false)).toBeNull();
    expect(await store.retenirClient(tenantId, false, `cus_test_${suffixe}`)).toBe(`cus_test_${suffixe}`);
    // Une seconde écriture concurrente pour le même mode ne remplace pas la première.
    expect(await store.retenirClient(tenantId, false, `cus_test_bis_${suffixe}`)).toBe(`cus_test_${suffixe}`);
    // Le client de test n'existe pas en live : le live a le sien.
    expect(await store.clientDe(tenantId, true)).toBeNull();
    expect(await store.retenirClient(tenantId, true, `cus_live_${suffixe}`)).toBe(`cus_live_${suffixe}`);
    expect(await store.clientDe(tenantId, false)).toBe(`cus_test_${suffixe}`);
    // Et un autre espace ne lit pas ce client.
    expect(await store.clientDe(autre, true)).toBeNull();
  });

  it('🔴 un achat porte SA session sur son mouvement ; l’historique rend son paiement et sa facture, dans l’espace', async () => {
    // Migration 0193 : le lien « Facture » de la page Crédit IA suit cette colonne, jamais la note.
    const store = new PgStripeStore(poolA);
    const credits = new PgCreditStore(poolA);
    const avecFacture = paiement({ factureId: 'in_itest_facture' });
    const sansFacture = paiement();
    await store.crediterPaiement(avecFacture);
    await store.crediterPaiement(sansFacture);
    const col = await poolA.query<{ stripe_session_id: string }>(
      `select stripe_session_id from agent_credit_mouvements where tenant_id = $1 and raison = 'achat' and stripe_session_id = $2`,
      [tenantId, avecFacture.sessionId],
    );
    expect(col.rowCount).toBe(1);
    const achats = (await credits.historique(tenantId, 50)).filter((l) => l.raison === 'achat');
    expect(achats.find((l) => l.paiementId === avecFacture.sessionId)).toMatchObject({ facture: true });
    expect(achats.find((l) => l.paiementId === sansFacture.sessionId)).toMatchObject({ facture: false });
    // Les autres lignes n'ont ni paiement ni facture.
    expect((await credits.historique(tenantId, 50)).filter((l) => l.raison !== 'achat').every((l) => l.paiementId === null && !l.facture)).toBe(true);
    // La facture se relit dans l'espace, et seulement là.
    expect(await store.factureDe(tenantId, avecFacture.sessionId)).toEqual({ factureId: 'in_itest_facture' });
    expect(await store.factureDe(tenantId, sansFacture.sessionId)).toEqual({ factureId: null });
    expect(await store.factureDe(autre, avecFacture.sessionId)).toBeNull();
  });

  it('🔴 la reprise de 0193 rattache un achat d’AVANT la colonne par sa note exacte, et rien d’autre', async () => {
    // L'achat de production d'avant la colonne : son mouvement n'a que la note. Le SQL de la reprise est LU dans la
    // migration, pas recopié, et rejoué ici.
    const store = new PgStripeStore(poolA);
    const p = paiement();
    await store.crediterPaiement(p);
    await poolA.query(`update agent_credit_mouvements set stripe_session_id = null where tenant_id = $1 and stripe_session_id = $2`, [tenantId, p.sessionId]);
    // Un achat d'un AUTRE espace qui porterait la même note ne doit pas être rattaché à ce paiement.
    await poolA.query(
      `insert into agent_credit_mouvements (tenant_id, delta_micro_eur, raison, note) values ($1, 1, 'achat', $2)`,
      [autre, `achat Stripe ${p.offre} (${p.sessionId})`],
    );
    const { readFileSync } = await import('node:fs');
    const sql = readFileSync(new URL('../../db/migrations/0193_credit_offert_et_factures.sql', import.meta.url), 'utf8');
    const reprise = sql.slice(sql.indexOf('update agent_credit_mouvements m'), sql.indexOf(';', sql.indexOf('update agent_credit_mouvements m')) + 1);
    await poolA.query(reprise);
    const r = await poolA.query<{ tenant_id: string; stripe_session_id: string | null }>(
      `select tenant_id, stripe_session_id from agent_credit_mouvements where raison = 'achat' and note = $1 order by tenant_id`,
      [`achat Stripe ${p.offre} (${p.sessionId})`],
    );
    expect(r.rows.find((l) => l.tenant_id === tenantId)?.stripe_session_id).toBe(p.sessionId);
    expect(r.rows.find((l) => l.tenant_id === autre)?.stripe_session_id).toBeNull();
  });
});
