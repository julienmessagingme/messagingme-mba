import '../../src/charger-env';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { pgSsl } from '../../src/db/ssl';
import { PgPremiersMessages } from '../../src/application/premier-message.pg';
import type { NouveauPremier } from '../../src/application/premier-message';

/**
 * LA FILE DES PREMIERS MESSAGES DE LA FILIÈRE APPLICATION (migration 0251), sur une vraie base.
 *
 * 🔴 CE QU'AUCUN TEST UNITAIRE NE VOIT : la clé unique par espace (un rejeu ne crée rien), le créneau réservé sous le
 * verrou de l'espace (deux demandes concurrentes s'espacent), la réclamation qui ne prend qu'une fois, le gel posé une
 * seule fois, et la contrainte « un modèle ou un texte » de `shopify_messages`.
 *
 * ⚠️ Ne PAS le lancer en local : le `DATABASE_URL` du `.env` local pointe sur la base de PRODUCTION. La CI monte un
 * Postgres jetable pour ça (job `integration`).
 */
const url = process.env.DATABASE_URL ?? '';
const NUMERO = '449990000091';

const codeDe = (err: unknown): string | undefined => (err as { code?: string } | null)?.code;
const contrainteDe = (err: unknown): string | undefined => (err as { constraint?: string } | null)?.constraint;

describe.skipIf(!url)('la file des premiers messages (0251)', () => {
  let pool: Pool;
  let file: PgPremiersMessages;
  let t1 = '';
  let t2 = '';
  let compteId = '';

  const message = (tenantId: string, cle: string, o: Partial<NouveauPremier> = {}): NouveauPremier => ({
    tenantId, cle, waId: '33612345678', texte: 'Merci pour votre commande', origine: 'shopify_commande', reference: 'orders/paid:1', ...o,
  });

  beforeAll(async () => {
    pool = new Pool({ connectionString: url, ssl: pgSsl() });
    file = new PgPremiersMessages(pool);
    const espace = async (nom: string) => (await pool.query<{ id: string }>(`insert into tenants (name) values ($1) returning id`, [nom])).rows[0]!.id;
    t1 = await espace('itest-premiers-1');
    t2 = await espace('itest-premiers-2');
    compteId = (await pool.query<{ id: string }>(
      `insert into comptes_application (tenant_id, numero, statut) values ($1, $2, 'relie') returning id`, [t1, NUMERO],
    )).rows[0]!.id;
  });

  afterAll(async () => {
    // La cascade des espaces emporte comptes_application, application_premiers_messages et shopify_messages.
    await pool.query('delete from tenants where id = any($1::uuid[])', [[t1, t2]]);
    await pool.end();
  });

  it('🔴 l’insertion est idempotente sur (espace, clé) : un rejeu rend la ligne existante, sans en créer', async () => {
    const a = await file.inserer(message(t1, 'shopify:b:orders/paid:1'), 0);
    const b = await file.inserer(message(t1, 'shopify:b:orders/paid:1', { texte: 'un autre texte' }), 0.9);
    expect(a.cree).toBe(true);
    expect(b).toEqual({ ligne: a.ligne, cree: false });
    expect(a.ligne).toMatchObject({ statut: 'en_file', essais: 0, texte: 'Merci pour votre commande', issue: null, messageId: null });
    const n = await pool.query(`select count(*)::int as n from application_premiers_messages where tenant_id = $1 and cle = $2`, [t1, 'shopify:b:orders/paid:1']);
    expect(n.rows[0].n).toBe(1);
    expect((await file.existant(t1, 'shopify:b:orders/paid:1'))?.id).toBe(a.ligne.id);
    // La clé est unique PAR ESPACE : la même dans un autre espace est un autre message.
    expect(await file.existant(t2, 'shopify:b:orders/paid:1')).toBeNull();
  });

  it('🔴 deux insertions concurrentes du même espace s’espacent d’au moins 30 s ; un autre espace ne les gêne pas', async () => {
    const [x, y] = await Promise.all([file.inserer(message(t1, 'concurrent-1'), 0), file.inserer(message(t1, 'concurrent-2'), 0)]);
    expect(x.cree && y.cree).toBe(true);
    const ecart = Math.abs(x.ligne.prevuLe.getTime() - y.ligne.prevuLe.getTime());
    expect(ecart).toBeGreaterThanOrEqual(30_000);
    // Avec l'aléa au plus haut, l'écart reste sous une minute.
    const z = await file.inserer(message(t1, 'concurrent-3'), 1);
    const dernier = Math.max(x.ligne.prevuLe.getTime(), y.ligne.prevuLe.getTime());
    expect(z.ligne.prevuLe.getTime() - dernier).toBeGreaterThanOrEqual(59_000);
    expect(z.ligne.prevuLe.getTime() - dernier).toBeLessThanOrEqual(60_001);
    // L'autre espace part de maintenant, pas derrière la file du premier.
    const autre = await file.inserer(message(t2, 'concurrent-1'), 0);
    const avance = autre.ligne.prevuLe.getTime() - Date.now();
    expect(avance).toBeGreaterThan(20_000);
    expect(avance).toBeLessThan(40_000);
    expect(autre.ligne.prevuLe.getTime()).toBeLessThan(dernier);
  });

  it('la réclamation ne prend qu’une fois ; remise en file et fin ne touchent qu’une ligne réclamée', async () => {
    const { ligne } = await file.inserer(message(t1, 'reclamation'), 0);
    const prise = await file.reclamer(ligne.id);
    expect(prise).toMatchObject({ id: ligne.id, statut: 'envoi', essais: 1 });
    expect(await file.reclamer(ligne.id)).toBeNull();
    const plusTard = new Date(Date.now() + 60_000);
    await file.remettreEnFile(ligne.id, plusTard);
    expect(await file.existant(t1, 'reclamation')).toMatchObject({ statut: 'en_file', prevuLe: plusTard });
    // Une ligne en file ne se termine pas sans avoir été réclamée.
    await file.terminer(ligne.id, 'abandonne', 'abandonne', null);
    expect((await file.existant(t1, 'reclamation'))?.statut).toBe('en_file');
    expect((await file.reclamer(ligne.id))?.essais).toBe(2);
    await file.terminer(ligne.id, 'envoye', 'envoye', `app:${compteId}:WA1`);
    const finie = await pool.query(`select statut, issue, message_id, envoye_le from application_premiers_messages where id = $1`, [ligne.id]);
    expect(finie.rows[0]).toMatchObject({ statut: 'envoye', issue: 'envoye', message_id: `app:${compteId}:WA1` });
    expect(finie.rows[0].envoye_le).toBeInstanceOf(Date);
    // Finie, elle ne se réclame plus et ne repart pas en file.
    expect(await file.reclamer(ligne.id)).toBeNull();
    await file.remettreEnFile(ligne.id, plusTard);
    expect((await file.existant(t1, 'reclamation'))?.statut).toBe('envoye');
  });

  it('le gel : posé une fois, pas reposé tant qu’il court, reposable une fois échu', async () => {
    expect(await file.geleJusqua(compteId)).toBeNull();
    const jusqua = new Date(Date.now() + 72 * 3_600_000);
    expect(await file.geler(compteId, jusqua)).toBe(true);
    expect(await file.geleJusqua(compteId)).toEqual(jusqua);
    expect(await file.geler(compteId, new Date(Date.now() + 100 * 3_600_000))).toBe(false);
    expect(await file.geleJusqua(compteId)).toEqual(jusqua);
    await pool.query(`update comptes_application set premiers_geles_jusqu_au = now() - interval '1 minute' where id = $1`, [compteId]);
    expect(await file.geler(compteId, jusqua)).toBe(true);
  });

  it('🔴 la purge efface toute ligne ancienne, finie, en file ou réclamée ; une ligne récente reste', async () => {
    const vieille = (await file.inserer(message(t2, 'purge-finie'), 0)).ligne;
    await file.reclamer(vieille.id);
    await file.terminer(vieille.id, 'abandonne', 'desabonne', null);
    // Un job perdu laisse `en_file`, un crash après la réclamation laisse `envoi` : elles ne partiront plus.
    const enFile = (await file.inserer(message(t2, 'purge-en-file'), 0)).ligne;
    const reclamee = (await file.inserer(message(t2, 'purge-reclamee'), 0)).ligne;
    await file.reclamer(reclamee.id);
    const recente = (await file.inserer(message(t2, 'purge-recente'), 0)).ligne;
    const recenteEnFile = (await file.inserer(message(t2, 'purge-recente-en-file'), 0)).ligne;
    await file.reclamer(recente.id);
    await file.terminer(recente.id, 'envoye', 'envoye', null);
    await pool.query(
      `update application_premiers_messages set cree_le = now() - interval '31 days' where id = any($1::uuid[])`,
      [[vieille.id, enFile.id, reclamee.id]],
    );
    expect(await file.purgerTermines(30)).toBeGreaterThanOrEqual(3);
    for (const cle of ['purge-finie', 'purge-en-file', 'purge-reclamee']) expect(await file.existant(t2, cle), cle).toBeNull();
    expect(await file.existant(t2, 'purge-recente')).not.toBeNull();
    expect((await file.existant(t2, 'purge-recente-en-file'))?.id).toBe(recenteEnFile.id);
  });

  it('les CHECK de la table refusent un numéro mal formé et une origine inconnue', async () => {
    const e1 = await file.inserer(message(t2, 'mauvais-numero', { waId: '123@lid' }), 0).catch((e: unknown) => e);
    expect(codeDe(e1)).toBe('23514');
    // Une origine hors de la liste, à dessein : c'est le CHECK qu'on éprouve, le type l'aurait refusée avant.
    const e2 = await file.inserer(message(t2, 'mauvaise-origine', { origine: 'campagne' as never }), 0).catch((e: unknown) => e);
    expect(codeDe(e2)).toBe('23514');
  });

  it('🔴 shopify_messages : un modèle OU un texte, jamais les deux ni aucun', async () => {
    const inserer = (evenement: string, modele: string | null, texte: string | null) => pool.query(
      `insert into shopify_messages (tenant_id, evenement, modele, langue, texte) values ($1, $2, $3, 'fr', $4)`,
      [t2, evenement, modele, texte],
    );
    // Les lignes d'avant (un modèle, pas de texte) restent valides ; un texte seul l'est aussi.
    await inserer('order_paid', 'confirmation_commande', null);
    await inserer('order_fulfilled', null, 'Votre commande {{order_number}} est partie');
    const deux = await inserer('checkout_abandoned', 'relance', 'Votre panier vous attend').catch((e: unknown) => e);
    expect([codeDe(deux), contrainteDe(deux)]).toEqual(['23514', 'shopify_messages_modele_ou_texte']);
    const aucun = await inserer('checkout_abandoned', null, null).catch((e: unknown) => e);
    expect([codeDe(aucun), contrainteDe(aucun)]).toEqual(['23514', 'shopify_messages_modele_ou_texte']);
    const vide = await inserer('checkout_abandoned', null, '').catch((e: unknown) => e);
    expect([codeDe(vide), contrainteDe(vide)]).toEqual(['23514', 'shopify_messages_texte_check']);
  });
});
