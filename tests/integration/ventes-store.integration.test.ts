import '../../src/charger-env';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { pgSsl } from '../../src/db/ssl';
import { PgVentesStore } from '../../src/shopify/ventes.pg';
import { LIGNE_RELANCE_PANIER } from '../../src/shopify/attribution';
import { PREFIXE_LIGNE_HUBSPOT } from '../../src/hubspot-workflow/envoi';

/**
 * Intégration du STORE DES VENTES (migration 0261, plan 2026-10-28, tâche 2). Ce qu'aucun faux ne prouve : quelles lignes de
 * Campagnes et quels messages deviennent une touche, l'unicité par commande, l'anonymisation. Espace jetable, détruit ici.
 */
const url = process.env.DATABASE_URL ?? '';

describe.skipIf(!url)('le store des ventes', () => {
  let pool: Pool;
  let store: PgVentesStore;
  let T = '';
  let contact = '';
  let fil = '';
  const maintenant = new Date('2026-10-20T12:00:00Z');
  const ilYA = (heures: number) => new Date(maintenant.getTime() - heures * 3_600_000);
  const depuis = ilYA(5 * 24);

  async function campagne(nom: string, o: { delivery?: string | null; workflow?: boolean; modele?: string; envoye?: Date } = {}): Promise<string> {
    const wf = o.workflow
      ? (await pool.query<{ id: string }>(`insert into workflows (tenant_id, name) values ($1, 'itest') returning id`, [T])).rows[0]!.id
      : null;
    const k = (await pool.query<{ id: string }>(
      `insert into campaigns (tenant_id, phone_number_id, name, category, template_name, template_language, status, workflow_id)
       values ($1, 'pn', $2, 'marketing', $3, 'fr', 'completed', $4) returning id`,
      [T, nom, o.modele ?? 'promo', wf],
    )).rows[0]!.id;
    await pool.query(
      `insert into campaign_recipients (campaign_id, contact_id, to_e164, status, sent_at, delivery_status)
       values ($1, $2, '+33600000001', 'sent', $3, $4)`,
      [k, contact, o.envoye ?? ilYA(24), o.delivery === undefined ? 'delivered' : o.delivery],
    );
    return k;
  }

  async function message(origine: string, statut: string | null, le = ilYA(2)): Promise<void> {
    await pool.query(
      `insert into conversation_messages (conversation_id, direction, type, body, origin, statut, created_at)
       values ($1, 'out', 'text', 'x', $2, $3, $4)`,
      [fil, origine, statut, le],
    );
  }

  /** La boutique de l'espace, branchée à cette date (la preuve par UTM n'insère que pour une boutique branchée avant le paiement). */
  async function brancher(le: Date): Promise<void> {
    await pool.query(
      `insert into shopify_boutiques (tenant_id, domaine, client_id, secret_chiffre, connectee_le)
       values ($1, $2, 'cid', 'chiffre', $3) on conflict (tenant_id) do update set connectee_le = excluded.connectee_le`,
      [T, `itest-ventes-${T.slice(0, 8)}.myshopify.com`, le],
    );
  }

  async function vider(): Promise<void> {
    await pool.query('delete from conversation_messages where conversation_id = $1', [fil]);
    await pool.query('delete from campaigns where tenant_id = $1', [T]);
    await pool.query('delete from workflows where tenant_id = $1', [T]);
    await pool.query('delete from ventes_attribuees where tenant_id = $1', [T]);
  }

  beforeAll(async () => {
    pool = new Pool({ connectionString: url, ssl: pgSsl() });
    store = new PgVentesStore(pool);
    T = (await pool.query<{ id: string }>(`insert into tenants (name) values ('itest-ventes') returning id`)).rows[0]!.id;
    contact = (await pool.query<{ id: string }>(
      `insert into contacts (tenant_id, phone_e164) values ($1, '+33600000001') returning id`, [T],
    )).rows[0]!.id;
    fil = (await pool.query<{ id: string }>(
      `insert into conversations (tenant_id, wa_id, contact_id) values ($1, '33600000001', $2) returning id`, [T, contact],
    )).rows[0]!.id;
  });

  afterAll(async () => {
    await pool.query('delete from tenants where id = $1', [T]);
    await pool.end();
  });

  it('une campagne livrée dans la période est une touche campagne, avec son modèle', async () => {
    await vider();
    const k = await campagne('Soldes', { modele: 'soldes_hiver' });
    expect(await store.touches(T, contact, depuis, maintenant, false)).toEqual([
      { source: 'campagne', le: ilYA(24), campaignId: k, modele: 'soldes_hiver', lanceScenario: false },
    ]);
  });

  it('🔴 les lignes Shopify (confirmation, expédition), [API] et HubSpot ne sont jamais une touche', async () => {
    await vider();
    await campagne('Shopify · commande payée · #1002');
    await campagne('Shopify · commande expédiée · #1002');
    await campagne('[API] essai');
    await campagne(`${PREFIXE_LIGNE_HUBSPOT}3f2a`);
    expect(await store.touches(T, contact, depuis, maintenant, false)).toEqual([]);
  });

  it('la relance de panier est une touche relance_panier, sans campagne', async () => {
    await vider();
    await campagne(LIGNE_RELANCE_PANIER, { modele: 'relance' });
    expect(await store.touches(T, contact, depuis, maintenant, false)).toEqual([
      { source: 'relance_panier', le: ilYA(24), campaignId: null, modele: 'relance', lanceScenario: false },
    ]);
  });

  it('un envoi seulement parti (sent) ne compte pas, sauf en filière application ; un échec jamais', async () => {
    await vider();
    await campagne('Parti', { delivery: 'sent' });
    await campagne('Échoué', { delivery: 'failed' });
    await message('ia', null);
    expect(await store.touches(T, contact, depuis, maintenant, false)).toEqual([]);
    const enApplication = await store.touches(T, contact, depuis, maintenant, true);
    expect(enApplication.map((t) => t.source).sort()).toEqual(['agent', 'campagne']);
  });

  it('une campagne qui lance un scénario compte sans accusé (son identifiant de message est synthétique)', async () => {
    await vider();
    await campagne('Avec scénario', { delivery: null, workflow: true });
    const [t] = await store.touches(T, contact, depuis, maintenant, false);
    expect(t).toMatchObject({ source: 'campagne', lanceScenario: true });
  });

  it('les messages ia et mba sont des touches agent et agent_meta, scenario une touche scenario ; humain, mcp et api non', async () => {
    await vider();
    await message('ia', 'delivered', ilYA(3));
    await message('mba', 'read', ilYA(2));
    await message('scenario', 'delivered', ilYA(1));
    for (const o of ['humain', 'mcp', 'api', 'campagne']) await message(o, 'delivered');
    expect((await store.touches(T, contact, depuis, maintenant, false)).map((t) => t.source)).toEqual(['scenario', 'agent_meta', 'agent']);
  });

  it('hors de la période, rien ; la dernière touche d’un modèle se lit sans limite de date', async () => {
    await vider();
    const k = await campagne('Ancienne', { modele: 'vieux', envoye: ilYA(24 * 30) });
    expect(await store.touches(T, contact, depuis, maintenant, false)).toEqual([]);
    expect(await store.derniereToucheDuModele(T, contact, 'vieux', maintenant, false)).toMatchObject({ source: 'campagne', campaignId: k });
    expect(await store.derniereToucheDuModele(T, contact, 'autre', maintenant, false)).toBeNull();
  });

  it('🔴 sans contact, la dernière CAMPAGNE de l’espace qui a envoyé le modèle, avant le paiement, hors lignes Shopify, [API] et HubSpot (2026-10-30)', async () => {
    await vider();
    await campagne('Ancienne', { modele: 'soldes', envoye: ilYA(24 * 30) });
    const recente = await campagne('Récente', { modele: 'soldes', envoye: ilYA(5) });
    await campagne('Après le paiement', { modele: 'soldes', envoye: new Date(maintenant.getTime() + 60_000) });
    await campagne('Échouée', { modele: 'soldes', envoye: ilYA(1), delivery: 'failed' });
    await campagne(LIGNE_RELANCE_PANIER, { modele: 'soldes', envoye: ilYA(1) });
    await campagne('[API] essai', { modele: 'soldes', envoye: ilYA(1) });
    await campagne(`${PREFIXE_LIGNE_HUBSPOT}workflow 1`, { modele: 'soldes', envoye: ilYA(1) });
    await campagne('Autre modèle', { modele: 'autre', envoye: ilYA(1) });
    expect(await store.derniereCampagneDuModele(T, 'soldes', maintenant, false)).toMatchObject({ source: 'campagne', campaignId: recente, modele: 'soldes' });
    expect(await store.derniereCampagneDuModele(T, 'inconnu', maintenant, false)).toBeNull();
  });

  it('🔴 appliquerPreuveUtm insère une vente prouvée SANS contact (commande sans téléphone ni fiche)', async () => {
    await vider();
    await brancher(ilYA(48));
    const k = await campagne('Soldes', { modele: 'soldes_hiver' });
    const vente = { contactId: null, montant: '32.95', devise: 'USD', payeeLe: maintenant, test: true, source: 'campagne' as const, campaignId: k, preuve: 'utm' as const, relanceLe: null };
    expect(await store.appliquerPreuveUtm(T, { ...vente, commandeId: 's1' })).toBe('appliquee');
    const r = (await pool.query(`select commande_id, contact_id, source, campaign_id, preuve from ventes_attribuees where tenant_id = $1`, [T])).rows;
    expect(r).toEqual([{ commande_id: 's1', contact_id: null, source: 'campagne', campaign_id: k, preuve: 'utm' }]);
  });

  it('🔴 enregistrer deux fois la même commande rend deja et laisse une ligne', async () => {
    await vider();
    const vente = {
      commandeId: '820982911946154508', contactId: contact, montant: '49.90', devise: 'EUR', payeeLe: maintenant, test: false,
      source: 'agent' as const, campaignId: null, preuve: null, relanceLe: null,
    };
    expect(await store.enregistrer(T, vente)).toBe('enregistree');
    expect(await store.enregistrer(T, vente)).toBe('deja');
    const n = (await pool.query<{ n: number }>('select count(*)::int as n from ventes_attribuees where tenant_id = $1', [T])).rows[0]!.n;
    expect(n).toBe(1);
  });

  it('anonymiserCommandes vide commande_id et contact_id, garde montant, devise et source', async () => {
    await vider();
    await store.enregistrer(T, {
      commandeId: '111', contactId: contact, montant: '12.5', devise: 'EUR', payeeLe: maintenant, test: false,
      source: 'relance_panier', campaignId: null, preuve: 'panier', relanceLe: ilYA(1),
    });
    expect(await store.anonymiserCommandes(T, ['111'])).toBe(1);
    const r = (await pool.query('select commande_id, contact_id, montant::text, devise, source from ventes_attribuees where tenant_id = $1', [T])).rows[0];
    expect(r).toEqual({ commande_id: null, contact_id: null, montant: '12.500', devise: 'EUR', source: 'relance_panier' });
  });

  it('🔴 appliquerPreuveUtm met à jour une vente sans preuve, jamais une preuve panier', async () => {
    await vider();
    const k = await campagne('Soldes', { modele: 'soldes_hiver' });
    const base = { contactId: contact, montant: '20', devise: 'EUR', payeeLe: maintenant, test: false };
    await store.enregistrer(T, { ...base, commandeId: 'u1', source: 'agent', campaignId: null, preuve: null, relanceLe: null });
    await store.enregistrer(T, { ...base, commandeId: 'u2', source: 'relance_panier', campaignId: null, preuve: 'panier', relanceLe: ilYA(2) });
    const prouvee = { ...base, source: 'campagne' as const, campaignId: k, preuve: 'utm' as const, relanceLe: null };
    expect(await store.appliquerPreuveUtm(T, { ...prouvee, commandeId: 'u1' })).toBe('appliquee');
    expect(await store.appliquerPreuveUtm(T, { ...prouvee, commandeId: 'u2' })).toBe('ignoree');
    const r = (await pool.query(`select commande_id, source, campaign_id, preuve from ventes_attribuees where tenant_id = $1 order by commande_id`, [T])).rows;
    expect(r).toEqual([
      { commande_id: 'u1', source: 'campagne', campaign_id: k, preuve: 'utm' },
      { commande_id: 'u2', source: 'relance_panier', campaign_id: null, preuve: 'panier' },
    ]);
  });

  it('🔴 appliquerPreuveUtm insère une vente prouvée pour une fiche vivante, rien pour une fiche anonymisée', async () => {
    await vider();
    await brancher(ilYA(48));
    const vente = { contactId: contact, montant: '20', devise: 'EUR', payeeLe: maintenant, test: false, source: 'agent' as const, campaignId: null, preuve: 'utm' as const, relanceLe: null };
    expect(await store.appliquerPreuveUtm(T, { ...vente, commandeId: 'n1' })).toBe('appliquee');
    const anonyme = (await pool.query<{ id: string }>(
      `insert into contacts (tenant_id, phone_e164, anonymized_at) values ($1, 'anon:itest', now()) returning id`, [T],
    )).rows[0]!.id;
    expect(await store.appliquerPreuveUtm(T, { ...vente, commandeId: 'n2', contactId: anonyme })).toBe('ignoree');
    const r = (await pool.query(`select commande_id, preuve from ventes_attribuees where tenant_id = $1 order by commande_id`, [T])).rows;
    expect(r).toEqual([{ commande_id: 'n1', preuve: 'utm' }]);
  });

  it('🔴 appliquerPreuveUtm ne recrée pas une vente quand la boutique a été rebranchée après le paiement (sa vente d’avant a été anonymisée)', async () => {
    await vider();
    // Désinstallée puis rebranchée pendant la relecture : l'effacement a anonymisé la vente, la reconnexion date d'après.
    await brancher(new Date(maintenant.getTime() + 600_000));
    const vente = { contactId: contact, montant: '20', devise: 'EUR', payeeLe: maintenant, test: false, source: 'agent' as const, campaignId: null, preuve: 'utm' as const, relanceLe: null };
    await pool.query(
      `insert into ventes_attribuees (tenant_id, commande_id, contact_id, montant, devise, payee_le, source) values ($1, null, null, 20, 'EUR', $2, 'agent')`,
      [T, maintenant],
    );
    expect(await store.appliquerPreuveUtm(T, { ...vente, commandeId: 'r1' })).toBe('ignoree');
    const n = (await pool.query<{ n: number }>('select count(*)::int as n from ventes_attribuees where tenant_id = $1', [T])).rows[0]!.n;
    expect(n).toBe(1);
  });

  it('panierRelance rend la date d’une relance partie, rien pour un panier non relancé ou refusé', async () => {
    await pool.query(
      `insert into shopify_paniers (tenant_id, jeton, telephone, relance_le, issue) values
         ($1, 'tok-envoye', '+33600000001', $2, 'envoye'), ($1, 'tok-refuse', '+33600000001', $2, 'desabonne'),
         ($1, 'tok-attente', '+33600000001', null, null)`,
      [T, ilYA(30)],
    );
    expect(await store.panierRelance(T, 'tok-envoye')).toEqual({ relanceLe: ilYA(30) });
    expect(await store.panierRelance(T, 'tok-refuse')).toBeNull();
    expect(await store.panierRelance(T, 'tok-attente')).toBeNull();
    expect(await store.panierRelance(T, 'inconnu')).toBeNull();
  });

  /** Une vente posée à la main, pour la lecture du chiffre (plan 2026-10-30, lot 2, tâche 1). */
  async function vente(o: {
    commande: string; montant: string; payee: Date; devise?: string; source?: string; campagne?: string | null;
    preuve?: string | null; relance?: Date | null; test?: boolean; espace?: string;
  }): Promise<void> {
    await pool.query(
      `insert into ventes_attribuees (tenant_id, commande_id, contact_id, montant, devise, payee_le, source, campaign_id, preuve, relance_le, test)
       values ($1, $2, null, $3::numeric, $4, $5, $6, $7, $8, $9, $10)`,
      [o.espace ?? T, o.commande, o.montant, o.devise ?? 'EUR', o.payee, o.source ?? 'campagne', o.campagne ?? null, o.preuve ?? null,
        o.relance ?? null, o.test ?? false],
    );
  }
  /** Du 15 au 20 octobre 2026, heure de Paris : du 2026-10-14T22:00Z au 2026-10-20T22:00Z. */
  const periode = { from: '2026-10-15', to: '2026-10-20' };

  it('lireChiffre : par devise, les tests à part, la part prouvée, une campagne supprimée gardée, rien hors période', async () => {
    await vider();
    const soldes = await campagne('Soldes');
    const noel = await campagne('Noël');
    await vente({ commande: 'a', montant: '100.50', payee: ilYA(2), campagne: soldes, preuve: 'utm' });
    await vente({ commande: 'b', montant: '50', payee: ilYA(3), campagne: soldes });
    await vente({ commande: 'c', montant: '30', payee: ilYA(4), devise: 'USD', source: 'agent' });
    await vente({ commande: 'd', montant: '20', payee: ilYA(5), campagne: noel });
    await vente({ commande: 'e', montant: '999', payee: ilYA(6), campagne: soldes, test: true });
    await vente({ commande: 'f', montant: '70', payee: new Date('2026-10-14T21:59:00Z'), source: 'agent' });
    await vente({ commande: 'g', montant: '15', payee: new Date('2026-10-20T22:00:00Z'), source: 'agent' });
    await pool.query('delete from campaigns where id = $1', [noel]);

    const l = await store.lireChiffre(T, periode);
    expect(l.totaux).toEqual([
      { test: false, devise: 'EUR', brut: '170.5', prouve: '100.5', commandes: 3 },
      { test: false, devise: 'USD', brut: '30', prouve: '0', commandes: 1 },
      { test: true, devise: 'EUR', brut: '999', prouve: '0', commandes: 1 },
    ]);
    expect(l.ventes).toEqual([
      { test: true, source: 'campagne', campaignId: soldes, nom: 'Soldes', devise: 'EUR', brut: '999', prouve: '0', commandes: 1 },
      { test: false, source: 'campagne', campaignId: soldes, nom: 'Soldes', devise: 'EUR', brut: '150.5', prouve: '100.5', commandes: 2 },
      { test: false, source: 'agent', campaignId: null, nom: null, devise: 'USD', brut: '30', prouve: '0', commandes: 1 },
      { test: false, source: 'campagne', campaignId: null, nom: null, devise: 'EUR', brut: '20', prouve: '0', commandes: 1 },
    ]);
  });

  it('lireChiffre : relancés par jour de relance, récupérés par date de relance, un autre espace jamais compté', async () => {
    await vider();
    await pool.query('delete from relances_panier_jour where tenant_id = $1', [T]);
    await pool.query(
      `insert into relances_panier_jour (tenant_id, jour, n) values ($1, '2026-10-14', 5), ($1, '2026-10-16', 2), ($1, '2026-10-20', 1)`,
      [T],
    );
    // Relancée la veille de la période, payée dedans : dans les ventes (date de paiement), pas dans les récupérés.
    await vente({ commande: 'r1', montant: '60', source: 'relance_panier', preuve: 'panier',
      relance: new Date('2026-10-14T20:00:00Z'), payee: new Date('2026-10-15T08:00:00Z') });
    await vente({ commande: 'r2', montant: '40', source: 'relance_panier', preuve: 'panier',
      relance: new Date('2026-10-16T10:00:00Z'), payee: new Date('2026-10-16T11:00:00Z') });
    await vente({ commande: 'r3', montant: '9.99', source: 'relance_panier', test: true,
      relance: new Date('2026-10-17T10:00:00Z'), payee: new Date('2026-10-17T11:00:00Z') });
    const autre = (await pool.query<{ id: string }>(`insert into tenants (name) values ('itest-ventes-autre') returning id`)).rows[0]!.id;
    try {
      await vente({ espace: autre, commande: 'x', montant: '1000', source: 'relance_panier',
        relance: new Date('2026-10-16T10:00:00Z'), payee: new Date('2026-10-16T11:00:00Z') });
      const l = await store.lireChiffre(T, periode);
      expect(l.relances).toBe(3);
      expect(l.recuperes).toEqual([
        { test: false, devise: 'EUR', montant: '40', commandes: 1 },
        { test: true, devise: 'EUR', montant: '9.99', commandes: 1 },
      ]);
      expect(l.totaux).toEqual([
        { test: false, devise: 'EUR', brut: '100', prouve: '100', commandes: 2 },
        { test: true, devise: 'EUR', brut: '9.99', prouve: '0', commandes: 1 },
      ]);
    } finally {
      await pool.query('delete from tenants where id = $1', [autre]);
    }
  });

  it('lireChiffre : un espace sans vente ni relance rend des listes vides et zéro', async () => {
    await vider();
    await pool.query('delete from relances_panier_jour where tenant_id = $1', [T]);
    expect(await store.lireChiffre(T, periode)).toEqual({ totaux: [], ventes: [], relances: 0, recuperes: [] });
  });
});
