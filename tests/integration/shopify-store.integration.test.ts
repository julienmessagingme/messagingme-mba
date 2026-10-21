import '../../src/charger-env';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomBytes, randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { pgSsl } from '../../src/db/ssl';
import { PgShopifyStore } from '../../src/shopify/store.pg';
import { PgContactStore } from '../../src/crm/contact-store.pg';

/**
 * Intégration du STORE SHOPIFY (migration 0246, plan 2026-10-21, lot 1). ISOLÉE par espaces jetables, créés et détruits
 * ici. Ce qu'aucun faux ne prouve : l'unicité du domaine, la reprise d'une boutique coupée, le dédoublonnage d'un
 * événement et son bail, et que la purge d'une fiche efface ses lignes Shopify.
 */
const url = process.env.DATABASE_URL ?? '';
const CLE = randomBytes(32).toString('hex');

describe.skipIf(!url)('le store Shopify', () => {
  let pool: Pool;
  let store: PgShopifyStore;
  let A = '';
  let B = '';
  const domaine = `itest-${randomUUID().slice(0, 8)}.myshopify.com`;
  const connexion = (par: string | null = null) => ({ domaine, clientId: 'cid', secretClair: 'shpss_itest', nom: 'Itest', pays: 'FR', devise: 'EUR', par });

  beforeAll(async () => {
    pool = new Pool({ connectionString: url, ssl: pgSsl() });
    store = new PgShopifyStore(pool, CLE);
    A = (await pool.query<{ id: string }>(`insert into tenants (name) values ('itest-shopify-a') returning id`)).rows[0]!.id;
    B = (await pool.query<{ id: string }>(`insert into tenants (name) values ('itest-shopify-b') returning id`)).rows[0]!.id;
  });

  afterAll(async () => {
    await pool.query('delete from tenants where id = any($1::uuid[])', [[A, B]]);
    await pool.end();
  });

  it('connecte la boutique ; `lire` ne rend pas le secret, `boutiqueParDomaine` le rend déchiffré', async () => {
    expect(await store.connecter(A, connexion())).toBe('ok');
    const vue = await store.lire(A);
    expect(vue).toMatchObject({ domaine, nom: 'Itest', pays: 'FR', devise: 'EUR', etat: 'connectee', consentement: null });
    expect(JSON.stringify(vue)).not.toContain('shpss_itest');
    expect(await store.boutiqueParDomaine(domaine)).toMatchObject({ tenantId: A, etat: 'connectee', secret: 'shpss_itest', consentementAffirme: false });
    const brut = (await pool.query<{ secret_chiffre: string }>('select secret_chiffre from shopify_boutiques where tenant_id = $1', [A])).rows[0]!;
    expect(brut.secret_chiffre).not.toContain('shpss_itest');
  });

  it('🔴 une boutique connectée ailleurs est refusée ; coupée, elle se reprend et l’autre espace perd son branchement', async () => {
    expect(await store.connecter(B, connexion())).toBe('boutique_ailleurs');
    await store.brancher(A, { evenement: 'order_paid', modele: 'm', langue: 'fr', variables: [], actif: true, par: null });
    expect(await store.couper(A, 'test')).toBe(true);
    expect(await store.couper(A, 'test')).toBe(false);
    expect(await store.boutiqueParDomaine(domaine)).toMatchObject({ tenantId: A, etat: 'coupee', secret: 'shpss_itest' });
    expect(await store.connecter(B, connexion())).toBe('ok');
    expect(await store.lire(A)).toBeNull();
    expect(await store.messages(A)).toEqual([]);
    expect(await store.boutiqueParDomaine(domaine)).toMatchObject({ tenantId: B, etat: 'connectee' });
  });

  it('brancher remplace le message de l’événement, et l’affirmation du consentement se note', async () => {
    await store.brancher(B, { evenement: 'order_paid', modele: 'a', langue: 'fr', variables: ['first_name'], actif: true, par: null });
    await store.brancher(B, { evenement: 'order_paid', modele: 'b', langue: 'fr', variables: ['order_number'], actif: false, par: null });
    const m = await store.messages(B);
    expect(m.map((x) => [x.evenement, x.modele, x.variables, x.actif])).toEqual([['order_paid', 'b', ['order_number'], false]]);
    await store.affirmerConsentement(B, null);
    expect((await store.lire(B))!.consentement).not.toBeNull();
    expect((await store.boutiqueParDomaine(domaine))!.consentementAffirme).toBe(true);
  });

  it('🔴 l’affirmation du consentement ne survit à aucune connexion, et se retire', async () => {
    // Relecture du lot 1 : gardée, une boutique branchée après une autre ferait écrire consentants ses clients.
    expect((await store.lire(B))!.consentement).not.toBeNull();
    expect(await store.connecter(B, { ...connexion(), domaine: `itest-${randomUUID().slice(0, 8)}.myshopify.com` })).toBe('ok');
    expect((await store.lire(B))!.consentement).toBeNull();
    expect(await store.connecter(B, connexion())).toBe('ok');
    await store.affirmerConsentement(B, null);
    expect(await store.connecter(B, connexion())).toBe('ok');
    expect((await store.lire(B))!.consentement).toBeNull();
    await store.affirmerConsentement(B, null);
    await store.retirerConsentement(B);
    expect((await store.boutiqueParDomaine(domaine))!.consentementAffirme).toBe(false);
  });

  it('🔴 un événement se réserve une fois ; sans issue au-delà du bail, il se reprend ; servi, il ne repart plus', async () => {
    const cle = `shopify:${domaine}:orders/paid:1`;
    expect(await store.reserverEvenement(B, cle, 'orders/paid')).toBe('nouveau');
    expect(await store.reserverEvenement(B, cle, 'orders/paid')).toBe('en_cours');
    await pool.query(`update shopify_evenements set maj_le = now() - interval '10 minutes' where tenant_id = $1 and cle = $2`, [B, cle]);
    expect(await store.reserverEvenement(B, cle, 'orders/paid')).toBe('nouveau');
    await store.noterIssue(B, cle, 'envoye');
    expect(await store.reserverEvenement(B, cle, 'orders/paid')).toBe('servi');
    expect(await store.compteurs(B, 30)).toEqual({ envoye: 1 });
    // Une réservation sans issue se libère ; une servie, non.
    await store.libererEvenement(B, cle);
    expect(await store.reserverEvenement(B, cle, 'orders/paid')).toBe('servi');
  });

  it('🔴 la purge d’une fiche efface son lien de commande et les paniers de son numéro', async () => {
    const contacts = new PgContactStore(pool);
    const e164 = '+33600000946';
    const fiche = (await contacts.upsertByPhoneReturningId({ tenantId: B, phoneE164: e164, profileName: 'Client', fields: {}, optInStatus: 'unknown', tags: [] })).id;
    await store.lierCommande(B, '1001', '77', fiche);
    await pool.query(`insert into shopify_paniers (tenant_id, jeton, telephone) values ($1, 'jeton-1', $2)`, [B, e164]);
    expect(await store.contactsLies(B, ['1001'], null)).toEqual([fiche]);
    expect(await store.contactsLies(B, [], '77')).toEqual([fiche]);
    expect(await store.contactsLies(A, ['1001'], '77')).toEqual([]);
    await contacts.purgeMany(B, [fiche]);
    expect((await pool.query('select 1 from shopify_commandes where tenant_id = $1', [B])).rowCount).toBe(0);
    expect((await pool.query('select 1 from shopify_paniers where tenant_id = $1', [B])).rowCount).toBe(0);
  });

  it('shop/redact efface tout le branchement de l’espace, et rien d’un autre', async () => {
    await store.reserverEvenement(B, 'k-redact', 'orders/paid');
    await store.effacerBoutique(B);
    expect(await store.lire(B)).toBeNull();
    expect(await store.messages(B)).toEqual([]);
    expect((await pool.query('select 1 from shopify_evenements where tenant_id = $1', [B])).rowCount).toBe(0);
    expect(await store.boutiqueParDomaine(domaine)).toBeNull();
  });
});
