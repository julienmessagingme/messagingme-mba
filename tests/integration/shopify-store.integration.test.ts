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
  const connexion = (par: string | null = null) => ({ domaine, clientId: 'cid', secretClair: 'shpss_itest', nom: 'Itest', pays: 'FR', devise: 'EUR', par, origine: 'claude_code' as const });

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
    // L'accès de l'import des clients (lot 3) : la boutique de L'ESPACE, secret déchiffré ; un autre espace n'a rien.
    expect(await store.acces(A)).toEqual({ domaine, clientId: 'cid', secret: 'shpss_itest', pays: 'FR', etat: 'connectee', origine: 'claude_code' });
    expect(await store.acces(B)).toBeNull();
    const brut = (await pool.query<{ secret_chiffre: string }>('select secret_chiffre from shopify_boutiques where tenant_id = $1', [A])).rows[0]!;
    expect(brut.secret_chiffre).not.toContain('shpss_itest');
  });

  it('🔴 une boutique connectée ailleurs est refusée ; coupée, elle se reprend et l’autre espace perd son branchement', async () => {
    expect(await store.connecter(B, connexion())).toBe('boutique_ailleurs');
    await store.brancher(A, { evenement: 'order_paid', modele: 'm', texte: null, langue: 'fr', variables: [], actif: true, par: null });
    expect(await store.couper(A, 'test')).toBe(true);
    expect(await store.couper(A, 'test')).toBe(false);
    expect(await store.boutiqueParDomaine(domaine)).toMatchObject({ tenantId: A, etat: 'coupee', secret: 'shpss_itest' });
    expect(await store.connecter(B, connexion())).toBe('ok');
    expect(await store.lire(A)).toBeNull();
    expect(await store.messages(A)).toEqual([]);
    expect(await store.boutiqueParDomaine(domaine)).toMatchObject({ tenantId: B, etat: 'connectee' });
  });

  it('brancher remplace le message de l’événement, et l’affirmation du consentement se note', async () => {
    await store.brancher(B, { evenement: 'order_paid', modele: 'a', texte: null, langue: 'fr', variables: ['first_name'], actif: true, par: null });
    await store.brancher(B, { evenement: 'order_paid', modele: 'b', texte: null, langue: 'fr', variables: ['order_number'], actif: false, par: null });
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
    // Retirer l'affirmation écarte les paniers ouverts notés sous elle ; un panier déjà relancé reste, pour les chiffres.
    await store.noterPanier(B, { jeton: 'ouvert-retrait', telephone: '+33600000951', nom: null, lien: 'https://l' });
    await store.noterPanier(B, { jeton: 'relance-retrait', telephone: '+33600000952', nom: null, lien: 'https://l' });
    await pool.query(`update shopify_paniers set relance_le = now() where tenant_id = $1 and jeton = 'relance-retrait'`, [B]);
    await store.retirerConsentement(B);
    expect((await store.boutiqueParDomaine(domaine))!.consentementAffirme).toBe(false);
    const restants = await pool.query<{ jeton: string }>(`select jeton from shopify_paniers where tenant_id = $1 and jeton like '%-retrait' order by jeton`, [B]);
    expect(restants.rows.map((r) => r.jeton)).toEqual(['relance-retrait']);
    // Rien ne reste derrière ce test : la purge, plus bas, compte TOUS les paniers de l'espace.
    await pool.query(`delete from shopify_paniers where tenant_id = $1 and jeton like '%-retrait'`, [B]);
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

/**
 * LES PANIERS (lot 2) : ce qu'aucun faux ne prouve. La réclamation pose `relance_le` dans la même écriture, donc un panier
 * ne se relance qu'une fois même sous deux balayages simultanés ; un panier fermé ne se rouvre jamais ; la fermeture peut
 * précéder le panier ; seuls les paniers d'une boutique connectée, au consentement affirmé et au message actif sont dus.
 */
describe.skipIf(!url)('le store Shopify : les paniers', () => {
  let pool: Pool;
  let store: PgShopifyStore;
  let C = '';
  const domaine = `itest-p-${randomUUID().slice(0, 8)}.myshopify.com`;
  const due = async (jeton: string) => pool.query(`update shopify_paniers set maj_le = now() - interval '2 hours' where tenant_id = $1 and jeton = $2`, [C, jeton]);

  beforeAll(async () => {
    pool = new Pool({ connectionString: url, ssl: pgSsl() });
    store = new PgShopifyStore(pool, CLE);
    C = (await pool.query<{ id: string }>(`insert into tenants (name) values ('itest-shopify-paniers') returning id`)).rows[0]!.id;
    await store.connecter(C, { domaine, clientId: 'cid', secretClair: 'shpss_itest', nom: null, pays: 'FR', devise: 'EUR', par: null, origine: 'claude_code' });
    await store.brancher(C, { evenement: 'checkout_abandoned', modele: 'relance', texte: null, langue: 'fr', variables: ['checkout_url'], actif: true, par: null });
  });

  afterAll(async () => {
    await pool.query('delete from tenants where id = $1', [C]);
    await pool.end();
  });

  it('🔴 un panier fermé ne se rouvre jamais, et la fermeture peut arriver AVANT lui', async () => {
    await store.fermerPanier(C, 'avant');
    await store.noterPanier(C, { jeton: 'avant', telephone: '+33600000947', nom: 'X', lien: 'https://l' });
    const r = (await pool.query<{ telephone: string | null; ferme_le: Date | null }>(`select telephone, ferme_le from shopify_paniers where tenant_id = $1 and jeton = 'avant'`, [C])).rows[0]!;
    expect(r.ferme_le).not.toBeNull();
    expect(r.telephone).toBeNull();
  });

  it('une valeur absente n’efface pas celle d’avant', async () => {
    await store.noterPanier(C, { jeton: 'p1', telephone: '+33600000948', nom: 'Julien', lien: 'https://lien-1' });
    await store.noterPanier(C, { jeton: 'p1', telephone: null, nom: null, lien: null });
    const r = (await pool.query<{ telephone: string; nom: string; lien: string }>(`select telephone, nom, lien from shopify_paniers where tenant_id = $1 and jeton = 'p1'`, [C])).rows[0]!;
    expect(r).toEqual({ telephone: '+33600000948', nom: 'Julien', lien: 'https://lien-1' });
  });

  it('🔴 rien n’est dû sans consentement affirmé, puis une seule réclamation sous deux balayages simultanés', async () => {
    await due('p1');
    expect((await store.reclamerPaniersDus(50, [])).filter((p) => p.tenantId === C)).toEqual([]);
    await store.affirmerConsentement(C, null);
    const [a, b] = await Promise.all([store.reclamerPaniersDus(50, []), store.reclamerPaniersDus(50, [])]);
    const miens = [...a, ...b].filter((p) => p.tenantId === C);
    expect(miens.map((p) => [p.jeton, p.telephone, p.lien, p.domaine, p.modele, p.variables])).toEqual([
      ['p1', '+33600000948', 'https://lien-1', domaine, 'relance', ['checkout_url']],
    ]);
    expect((await store.reclamerPaniersDus(50, [])).filter((p) => p.tenantId === C)).toEqual([]);
    await store.noterIssuePanier(C, 'p1', 'envoye');
  });

  it('un panier pas encore échu, fermé, sur un message éteint ou une boutique coupée n’est pas dû', async () => {
    await store.noterPanier(C, { jeton: 'recent', telephone: '+33600000949', nom: null, lien: 'https://l' });
    await store.noterPanier(C, { jeton: 'ferme', telephone: '+33600000950', nom: null, lien: 'https://l' });
    await due('ferme');
    await store.fermerPanier(C, 'ferme');
    expect((await store.reclamerPaniersDus(50, [])).filter((p) => p.tenantId === C)).toEqual([]);
    await store.noterPanier(C, { jeton: 'eteint', telephone: '+33600000951', nom: null, lien: 'https://l' });
    await due('eteint');
    await store.brancher(C, { evenement: 'checkout_abandoned', modele: 'relance', texte: null, langue: 'fr', variables: ['checkout_url'], actif: false, par: null });
    expect((await store.reclamerPaniersDus(50, [])).filter((p) => p.tenantId === C)).toEqual([]);
    await store.brancher(C, { evenement: 'checkout_abandoned', modele: 'relance', texte: null, langue: 'fr', variables: ['checkout_url'], actif: true, par: null });
    await store.couper(C, 'test');
    expect((await store.reclamerPaniersDus(50, [])).filter((p) => p.tenantId === C)).toEqual([]);
  });

  it('les compteurs : relancés par issue, fermés à temps, en attente, seuls les paniers notés ; la purge à 7 jours', async () => {
    const c = await store.compteursPaniers(C, 7);
    expect(c.relances).toEqual({ envoye: 1 });
    // 'ferme' seul : la ligne écrite par une commande arrivée AVANT son panier ('avant', sans téléphone) n'en sauve aucun.
    expect(c.fermesATemps).toBe(1);
    expect(c.enAttente).toBe(2);
    await pool.query(`update shopify_paniers set ouvert_le = now() - interval '8 days' where tenant_id = $1 and jeton = 'recent'`, [C]);
    expect(await store.purgerPaniers(7)).toBeGreaterThanOrEqual(1);
    expect((await pool.query(`select 1 from shopify_paniers where tenant_id = $1 and jeton = 'recent'`, [C])).rowCount).toBe(0);
  });

  it('🔴 fermer un panier existant n’en écrit aucun ; une commande ferme ceux de son numéro ; un effacement les retire', async () => {
    await store.fermerPanierExistant(C, 'jamais-vu');
    expect((await pool.query(`select 1 from shopify_paniers where tenant_id = $1 and jeton = 'jamais-vu'`, [C])).rowCount).toBe(0);
    await store.noterPanier(C, { jeton: 'x1', telephone: '+33600000952', nom: null, lien: 'https://l' });
    await store.noterPanier(C, { jeton: 'x2', telephone: '+33600000952', nom: null, lien: 'https://l' });
    await store.noterPanier(C, { jeton: 'x3', telephone: '+33600000953', nom: null, lien: 'https://l' });
    expect(await store.panierOuvert(C, 'x1')).toBe(true);
    await store.fermerPanierExistant(C, 'x1');
    expect(await store.panierOuvert(C, 'x1')).toBe(false);
    await store.fermerPaniersDuTelephone(C, '+33600000952');
    expect([await store.panierOuvert(C, 'x2'), await store.panierOuvert(C, 'x3')]).toEqual([false, true]);
    await store.effacerPaniersDuTelephone(C, '+33600000953');
    expect((await pool.query(`select 1 from shopify_paniers where tenant_id = $1 and jeton = 'x3'`, [C])).rowCount).toBe(0);
    expect(await store.panierOuvert(C, 'x3')).toBe(false);
  });

  it('🔴 reconnecter efface les paniers ; le délai se compte en MINUTES de la boutique ; un panier verrouillé est sauté', async () => {
    await store.connecter(C, { domaine, clientId: 'cid', secretClair: 'shpss_itest', nom: null, pays: 'FR', devise: 'EUR', par: null, origine: 'claude_code' });
    expect((await pool.query('select 1 from shopify_paniers where tenant_id = $1', [C])).rowCount).toBe(0);
    await store.affirmerConsentement(C, null);
    await store.reglerDelaiPanier(C, 60);
    await store.noterPanier(C, { jeton: 'delai', telephone: '+33600000954', nom: null, lien: 'https://l' });
    await pool.query(`update shopify_paniers set maj_le = now() - interval '30 minutes' where tenant_id = $1 and jeton = 'delai'`, [C]);
    expect((await store.reclamerPaniersDus(50, [])).filter((p) => p.tenantId === C)).toEqual([]);
    await store.reglerDelaiPanier(C, 15);
    // Un autre balayage tient la ligne : `skip locked` la saute au lieu de l'attendre (ni double relance, ni blocage).
    const verrou = await pool.connect();
    try {
      await verrou.query('begin');
      await verrou.query(`select 1 from shopify_paniers where tenant_id = $1 and jeton = 'delai' for update`, [C]);
      expect((await store.reclamerPaniersDus(50, [])).filter((p) => p.tenantId === C)).toEqual([]);
    } finally {
      await verrou.query('rollback');
      verrou.release();
    }
    expect((await store.reclamerPaniersDus(50, [])).filter((p) => p.tenantId === C).map((p) => p.jeton)).toEqual(['delai']);
  });
});

describe.skipIf(!url)('le store Shopify : la console (origine, attentes, migration 0249)', () => {
  let pool: Pool;
  let store: PgShopifyStore;
  let D = '';
  const domaine = `itest-c-${randomUUID().slice(0, 8)}.myshopify.com`;
  const connexion = { domaine, clientId: 'cid', secretClair: 'shpss_itest', nom: null, pays: 'FR', devise: 'EUR', par: null, origine: 'console' as const };

  beforeAll(async () => {
    pool = new Pool({ connectionString: url, ssl: pgSsl() });
    store = new PgShopifyStore(pool, CLE);
    D = (await pool.query<{ id: string }>(`insert into tenants (name) values ('itest-shopify-console') returning id`)).rows[0]!.id;
  });

  afterAll(async () => {
    await pool.query('delete from tenants where id = $1', [D]);
    await pool.end();
  });

  it('l’origine est gardée et rendue par la vue, l’accès et la boutique signée', async () => {
    expect(await store.connecter(D, connexion)).toBe('ok');
    expect((await store.lire(D))?.origine).toBe('console');
    expect((await store.acces(D))?.origine).toBe('console');
    expect((await store.boutiqueParDomaine(domaine))?.origine).toBe('console');
  });

  it('🔴 une attente par événement : la nouvelle remplace, le retrait par modèle la rend, le message actif n’est pas touché', async () => {
    await store.brancher(D, { evenement: 'checkout_abandoned', modele: 'ancien', texte: null, langue: 'fr', variables: ['checkout_url'], actif: true, par: null });
    await store.poserAttente(D, { evenement: 'checkout_abandoned', modele: 'shopify_a', langue: 'fr', variables: ['first_name'], delaiMinutes: 15, par: null });
    await store.poserAttente(D, { evenement: 'checkout_abandoned', modele: 'shopify_b', langue: 'fr', variables: ['first_name', 'checkout_url'], delaiMinutes: 30, par: null });
    expect((await store.attentes(D)).map((a) => [a.modele, a.delaiMinutes, a.variables])).toEqual([['shopify_b', 30, ['first_name', 'checkout_url']]]);
    expect((await store.message(D, 'checkout_abandoned'))?.modele).toBe('ancien');
    // L'activation lit l'attente sans la retirer : elle branche d'abord, retire ensuite.
    expect(await store.attenteDuModele(D, 'shopify_b', 'fr')).toMatchObject({ evenement: 'checkout_abandoned', delaiMinutes: 30 });
    expect(await store.attenteDuModele(D, 'shopify_b', 'en')).toBeNull();
    expect(await store.attentes(D)).toHaveLength(1);
    expect(await store.retirerAttente(D, { modele: 'shopify_a', langue: 'fr' })).toBeNull();
    expect(await store.retirerAttente(D, { modele: 'shopify_b', langue: 'fr' })).toMatchObject({ evenement: 'checkout_abandoned', modele: 'shopify_b' });
    expect(await store.attentes(D)).toEqual([]);
  });

  it('le filet ne voit que les attentes anciennes ; l’effacement du branchement les emporte', async () => {
    await store.poserAttente(D, { evenement: 'order_paid', modele: 'shopify_c', langue: 'fr', variables: [], delaiMinutes: null, par: null });
    expect((await store.attentesAnciennes(10, 50)).filter((a) => a.tenantId === D)).toEqual([]);
    await pool.query(`update shopify_messages_attente set cree_le = now() - interval '20 minutes' where tenant_id = $1`, [D]);
    expect((await store.attentesAnciennes(10, 50)).filter((a) => a.tenantId === D).map((a) => a.modele)).toEqual(['shopify_c']);
    await store.effacerBoutique(D);
    expect(await store.attentes(D)).toEqual([]);
    expect(await store.lire(D)).toBeNull();
  });
});

/**
 * LE TEXTE D'UN NUMÉRO RELIÉ PAR QR CODE (migration 0251, plan 2026-10-23, tâche 5) : ce qu'aucun faux ne prouve. Brancher
 * un texte vide le modèle (la contrainte « l'un ou l'autre ») ; la réclamation n'examine pas les espaces exclus et rend le
 * texte du message ; un panier libéré redevient dû, dans SON espace, et pas s'il porte déjà son issue.
 */
describe.skipIf(!url)('le store Shopify : le texte d’un numéro relié par QR code (migration 0251)', () => {
  let pool: Pool;
  let store: PgShopifyStore;
  let E = '';
  let F = '';
  const brancherRelance = (t: string, m: { modele: string | null; texte: string | null }) =>
    store.brancher(t, { evenement: 'checkout_abandoned', ...m, langue: 'fr', variables: ['checkout_url'], actif: true, par: null });
  const miens = <T extends { tenantId: string }>(paniers: T[]): T[] => paniers.filter((p) => p.tenantId === E || p.tenantId === F);

  beforeAll(async () => {
    pool = new Pool({ connectionString: url, ssl: pgSsl() });
    store = new PgShopifyStore(pool, CLE);
    E = (await pool.query<{ id: string }>(`insert into tenants (name) values ('itest-shopify-texte-e') returning id`)).rows[0]!.id;
    F = (await pool.query<{ id: string }>(`insert into tenants (name) values ('itest-shopify-texte-f') returning id`)).rows[0]!.id;
    for (const t of [E, F]) {
      await store.connecter(t, { domaine: `itest-t-${randomUUID().slice(0, 8)}.myshopify.com`, clientId: 'cid', secretClair: 'shpss_itest', nom: null, pays: 'FR', devise: 'EUR', par: null, origine: 'claude_code' });
      await store.affirmerConsentement(t, null);
    }
  });

  afterAll(async () => {
    await pool.query('delete from tenants where id = any($1::uuid[])', [[E, F]]);
    await pool.end();
  });

  it('brancher un texte vide le modèle, et rebrancher un modèle vide le texte', async () => {
    await store.brancher(E, { evenement: 'order_paid', modele: 'commande_payee', texte: null, langue: 'fr', variables: ['first_name'], actif: true, par: null });
    await store.brancher(E, { evenement: 'order_paid', modele: null, texte: 'Merci {{first_name}} pour {{order_number}}', langue: 'fr', variables: ['first_name', 'order_number'], actif: true, par: null });
    expect(await store.message(E, 'order_paid')).toMatchObject({ modele: null, texte: 'Merci {{first_name}} pour {{order_number}}', variables: ['first_name', 'order_number'], actif: true });
    await store.brancher(E, { evenement: 'order_paid', modele: 'commande_payee', texte: null, langue: 'fr', variables: [], actif: false, par: null });
    expect(await store.message(E, 'order_paid')).toMatchObject({ modele: 'commande_payee', texte: null, actif: false });
  });

  it('🔴 la réclamation n’examine pas les espaces exclus, et rend le texte du message ; seule une relance en texte compte parmi les espaces à examiner', async () => {
    await brancherRelance(E, { modele: null, texte: 'Votre panier : {{checkout_url}}' });
    await brancherRelance(F, { modele: 'relance', texte: null });
    await store.noterPanier(E, { jeton: 'e1', telephone: '+33600000961', nom: null, lien: 'https://l' });
    await store.noterPanier(F, { jeton: 'f1', telephone: '+33600000962', nom: null, lien: 'https://l' });
    await pool.query(`update shopify_paniers set maj_le = now() - interval '2 hours' where tenant_id = any($1::uuid[])`, [[E, F]]);
    const enTexte = await store.espacesAPaniersDusEnTexte(1000);
    expect([enTexte.includes(E), enTexte.includes(F)]).toEqual([true, false]);
    expect(miens(await store.reclamerPaniersDus(50, [E])).map((p) => [p.tenantId, p.jeton])).toEqual([[F, 'f1']]);
    const e = (await store.reclamerPaniersDus(50, [])).filter((p) => p.tenantId === E);
    expect(e.map((p) => [p.jeton, p.modele, p.texte, p.variables])).toEqual([['e1', null, 'Votre panier : {{checkout_url}}', ['checkout_url']]]);
    // Réclamé, il n'est plus dû : l'espace n'est plus à examiner.
    expect(await store.espacesAPaniersDusEnTexte(1000)).not.toContain(E);
  });

  it('🔴 un panier libéré redevient dû, dans SON espace seulement, et pas s’il porte déjà son issue', async () => {
    await store.libererPanier(F, 'e1');
    expect((await store.reclamerPaniersDus(50, [])).filter((p) => p.tenantId === E)).toEqual([]);
    await store.libererPanier(E, 'e1');
    expect((await store.reclamerPaniersDus(50, [])).filter((p) => p.tenantId === E).map((p) => p.jeton)).toEqual(['e1']);
    await store.noterIssuePanier(E, 'e1', 'en_file');
    await store.libererPanier(E, 'e1');
    expect((await store.reclamerPaniersDus(50, [])).filter((p) => p.tenantId === E)).toEqual([]);
  });
});
